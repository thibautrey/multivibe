#import "MVLlama.h"
#include "llama.h"
#include "common.h"
#include "chat.h"
#include "sampling.h"
#include <atomic>
#include <mutex>
#include <stdexcept>

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
    try {
        if (!_context) throw std::runtime_error("Téléchargez ce modèle avant de l’utiliser.");
        common_chat_templates_inputs inputs;
        inputs.messages = common_chat_msgs_parse_oaicompat(common_json::parse(messages.UTF8String));
        inputs.tools = common_chat_tools_parse_oaicompat(common_json::parse(tools.UTF8String));
        inputs.enable_thinking = false;
        inputs.reasoning_format = COMMON_REASONING_FORMAT_DEEPSEEK;
        common_chat_params formatted;
        std::vector<llama_token> tokens;
        // Drop whole oldest exchanges only; never leave an orphan tool result.
        for (;;) {
            formatted = common_chat_templates_apply(_templates.get(), inputs);
            tokens = common_tokenize(_context, formatted.prompt, true, true);
            if (tokens.size() + 1024 <= llama_n_ctx(_context)) break;
            size_t first = inputs.messages.front().role == "system" ? 1 : 0;
            size_t next = first + 1;
            while (next < inputs.messages.size() && inputs.messages[next].role != "user") ++next;
            if (next >= inputs.messages.size()) throw std::runtime_error("Ce message est trop long. Réduisez-le pour ce modèle.");
            inputs.messages.erase(inputs.messages.begin() + first, inputs.messages.begin() + next);
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
        std::unique_ptr<common_sampler, decltype(&common_sampler_free)> sampler(common_sampler_init(_model, sp), common_sampler_free);
        if (!sampler) throw std::runtime_error("Impossible de préparer la réponse.");
        std::string output, published;
        common_chat_msg parsed;
        bool ended = false;
        for (int i = 0; i < 1024; ++i) {
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
