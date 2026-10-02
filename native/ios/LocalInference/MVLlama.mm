#import "MVLlama.h"
#include "llama.h"
#include "common.h"
#include "chat.h"
#include "sampling.h"
#include <atomic>
#include <mutex>
#include <stdexcept>

namespace {
struct PreparedPrompt {
    common_chat_params formatted;
    std::vector<llama_token> tokens;
};
// Shared by preflight and completion so tool schemas, thinking settings and special tokens agree.
static PreparedPrompt preparePrompt(llama_context *context, const common_chat_templates *templates,
                                    NSString *messages, NSString *tools, int reservedOutputTokens) {
    if (!context) throw std::runtime_error("Téléchargez ce modèle avant de l’utiliser.");
    if (reservedOutputTokens < 1 || static_cast<uint64_t>(reservedOutputTokens) >= llama_n_ctx(context))
        throw std::runtime_error("La réserve de réponse est invalide pour ce modèle.");
    common_chat_templates_inputs inputs;
    inputs.messages = common_chat_msgs_parse_oaicompat(common_json::parse(messages.UTF8String));
    if (inputs.messages.empty()) throw std::runtime_error("Une conversation est requise.");
    inputs.tools = common_chat_tools_parse_oaicompat(common_json::parse(tools.UTF8String));
    inputs.enable_thinking = false;
    inputs.reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
    auto formatted = common_chat_templates_apply(templates, inputs);
    auto tokens = common_tokenize(context, formatted.prompt, true, true);
    return {std::move(formatted), std::move(tokens)};
}
}

@implementation MVLlama {
    llama_model *_model;
    llama_context *_context;
    common_chat_templates_ptr _templates;
    std::atomic<bool> _cancelled;
    std::string _path;
}
- (instancetype)init {
    if ((self = [super init])) {
        static std::once_flag once;
        std::call_once(once, [] { llama_backend_init(); });
        _cancelled = false;
    }
    return self;
}
- (void)cancel { _cancelled.store(true); }
- (void)resetCancellation { _cancelled.store(false); }
- (void)unload {
    _templates.reset();
    if (_context) { llama_free(_context); _context = nullptr; }
    if (_model) { llama_model_free(_model); _model = nullptr; }
    _path.clear();
}
- (void)dealloc { [self unload]; }
- (BOOL)loadPath:(NSString *)path contextSize:(int)contextSize error:(NSError **)error {
    try {
        if (_context && _path == path.UTF8String) return YES;
        [self unload];
        auto mp = llama_model_default_params();
        mp.n_gpu_layers = 99;
        mp.progress_callback = [](float, void *ctx) { return !((std::atomic<bool> *)ctx)->load(); };
        mp.progress_callback_user_data = &_cancelled;
        _model = llama_model_load_from_file(path.UTF8String, mp);
        if (!_model) throw std::runtime_error("Impossible de charger ce modèle sur cet appareil.");
        auto cp = llama_context_default_params();
        cp.n_ctx = contextSize; cp.n_batch = 256; cp.n_ubatch = 128;
        cp.n_threads = std::min(4, (int)[NSProcessInfo processInfo].activeProcessorCount);
        cp.n_threads_batch = cp.n_threads;
        cp.abort_callback = [](void *ctx) { return ((std::atomic<bool> *)ctx)->load(); };
        cp.abort_callback_data = &_cancelled;
        _context = llama_init_from_model(_model, cp);
        if (!_context) throw std::runtime_error("Mémoire insuffisante pour charger ce modèle.");
        _templates = common_chat_templates_init(_model, "");
        if (!_templates) throw std::runtime_error("Le format de conversation de ce modèle est indisponible.");
        _path = path.UTF8String;
        return YES;
    } catch (const std::exception &e) {
        [self unload];
        if (error) *error = [NSError errorWithDomain:@"LocalInference" code:1 userInfo:@{NSLocalizedDescriptionKey: @(e.what())}];
        return NO;
    }
}
- (NSString *)completeMessages:(NSString *)messages tools:(NSString *)tools onText:(void (^)(NSString *))onText error:(NSError **)error {
    return [self completeMessages:messages tools:tools reservedOutputTokens:1024 onText:onText error:error];
}
- (NSDictionary<NSString *, NSNumber *> *)preflightMessages:(NSString *)messages tools:(NSString *)tools
                                      reservedOutputTokens:(int)reservedOutputTokens error:(NSError **)error {
    try {
        if (_cancelled.load()) throw std::runtime_error("Réponse interrompue.");
        const auto prepared = preparePrompt(_context, _templates.get(), messages, tools, reservedOutputTokens);
        return @{@"promptTokens": @(prepared.tokens.size()), @"contextTokens": @(llama_n_ctx(_context)),
                 @"reservedOutputTokens": @(reservedOutputTokens)};
    } catch (const std::exception &e) {
        if (error) *error = [NSError errorWithDomain:@"LocalInference" code:3 userInfo:@{NSLocalizedDescriptionKey: @(e.what())}];
        return nil;
    }
}
- (NSString *)completeMessages:(NSString *)messages tools:(NSString *)tools reservedOutputTokens:(int)reservedOutputTokens
                       onText:(void (^)(NSString *))onText error:(NSError **)error {
    try {
        if (_cancelled.load()) throw std::runtime_error("Réponse interrompue.");
        auto prepared = preparePrompt(_context, _templates.get(), messages, tools, reservedOutputTokens);
        const auto &formatted = prepared.formatted;
        auto &tokens = prepared.tokens;
        // Never silently remove history. Compaction belongs to the durable orchestration layer.
        if (tokens.size() > llama_n_ctx(_context) - static_cast<uint32_t>(reservedOutputTokens)) {
            if (error) *error = [NSError errorWithDomain:@"LocalInference" code:4 userInfo:@{
                NSLocalizedDescriptionKey: @"Le contexte dépasse la capacité de ce modèle. Une compaction est nécessaire avant de continuer.",
                @"promptTokens": @(tokens.size()), @"contextTokens": @(llama_n_ctx(_context)),
                @"reservedOutputTokens": @(reservedOutputTokens)}];
            return nil;
        }
        llama_memory_clear(llama_get_memory(_context), true);
        for (size_t pos = 0; pos < tokens.size(); pos += 256) {
            if (_cancelled.load()) throw std::runtime_error("Réponse interrompue.");
            auto batch = llama_batch_get_one(tokens.data() + pos, (int)std::min<size_t>(256, tokens.size() - pos));
            if (llama_decode(_context, batch) != 0) throw std::runtime_error("Le modèle n’a pas pu lire ce message.");
        }
        common_chat_parser_params parser(formatted);
        parser.reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
        if (!formatted.parser.empty()) parser.parser.load(formatted.parser);
        common_params_sampling sp;
        sp.temp = 0.6f;
        if (!formatted.grammar.empty()) {
            sp.grammar = common_grammar(COMMON_GRAMMAR_TYPE_TOOL_CALLS, formatted.grammar);
            sp.grammar_lazy = formatted.grammar_lazy;
            sp.grammar_triggers = formatted.grammar_triggers;
            sp.generation_prompt = formatted.generation_prompt;
            for (const auto & text : formatted.preserved_tokens) {
                const auto ids = common_tokenize(_context, text, false, true);
                if (ids.size() == 1) sp.preserved_tokens.insert(ids.front());
            }
        }
        std::unique_ptr<common_sampler, decltype(&common_sampler_free)> sampler(common_sampler_init(_model, sp), common_sampler_free);
        if (!sampler) throw std::runtime_error("Impossible de préparer la réponse.");
        std::string output, published;
        common_chat_msg parsed;
        bool ended = false;
        for (int i = 0; i < reservedOutputTokens; ++i) {
            if (_cancelled.load()) throw std::runtime_error("Réponse interrompue.");
            auto token = common_sampler_sample(sampler.get(), _context, -1);
            common_sampler_accept(sampler.get(), token, true);
            if (llama_vocab_is_eog(llama_model_get_vocab(_model), token)) { ended = true; break; }
            output += common_token_to_piece(_context, token, true);
            parsed = common_chat_parse(output, true, parser);
            if (parsed.content.size() > published.size() && parsed.content.compare(0, published.size(), published) == 0) {
                auto delta = parsed.content.substr(published.size());
                NSString *text = [[NSString alloc] initWithBytes:delta.data() length:delta.size() encoding:NSUTF8StringEncoding];
                if (text) { onText(text); published = parsed.content; }
            }
            auto batch = llama_batch_get_one(&token, 1);
            if (llama_decode(_context, batch) != 0) throw std::runtime_error("La réponse a été interrompue par manque de mémoire.");
        }
        if (!ended) throw std::runtime_error("La réponse a atteint la limite de ce modèle. Demandez une réponse plus courte.");
        parsed = common_chat_parse(output, false, parser);
        for (size_t i = 0; i < parsed.tool_calls.size(); ++i) {
            if (parsed.tool_calls[i].id.empty()) parsed.tool_calls[i].id = "call_" + std::to_string(i + 1);
        }
        if (parsed.content.size() > published.size() && parsed.content.compare(0, published.size(), published) == 0) {
            auto delta = parsed.content.substr(published.size());
            NSString *text = [[NSString alloc] initWithBytes:delta.data() length:delta.size() encoding:NSUTF8StringEncoding];
            if (text) onText(text);
        }
        auto json = parsed.to_json_oaicompat().dump();
        return [[NSString alloc] initWithBytes:json.data() length:json.size() encoding:NSUTF8StringEncoding];
    } catch (const std::exception &e) {
        if (error) *error = [NSError errorWithDomain:@"LocalInference" code:2 userInfo:@{NSLocalizedDescriptionKey: @(e.what())}];
        return nil;
    }
}
@end
