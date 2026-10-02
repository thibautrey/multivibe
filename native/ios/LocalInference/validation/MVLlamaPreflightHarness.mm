#import "../MVLlama.h"
#include <cassert>

// Run against a real compatible GGUF in the native inference harness environment.
// No completion is generated: only tokenization and deliberate overflow rejection.
int main(int argc, char **argv) {
    @autoreleasepool {
        assert(argc == 2);
        MVLlama *engine = [MVLlama new];
        NSError *error = nil;
        assert([engine loadPath:@(argv[1]) contextSize:4096 error:&error]);
        NSString *messages = @"[{\"role\":\"user\",\"content\":\"Hello\"}]";
        NSString *tools = @"[{\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"description\":\"Find a document by its identifier\",\"parameters\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}}}]";
        NSDictionary *plain = [engine preflightMessages:messages tools:@"[]" reservedOutputTokens:1024 error:&error];
        assert(plain && !error && [plain[@"promptTokens"] unsignedLongLongValue] > 0);
        assert([plain[@"contextTokens"] intValue] == 4096 && [plain[@"reservedOutputTokens"] intValue] == 1024);
        NSDictionary *withTools = [engine preflightMessages:messages tools:tools reservedOutputTokens:1024 error:&error];
        assert(withTools && !error && [withTools[@"promptTokens"] unsignedLongLongValue] > [plain[@"promptTokens"] unsignedLongLongValue]);
        assert([withTools isEqual:[engine preflightMessages:messages tools:tools reservedOutputTokens:1024 error:&error]]);
        NSDictionary *summary = [engine preflightMessages:messages tools:@"[]" reservedOutputTokens:204 error:&error];
        assert([summary[@"promptTokens"] isEqual:plain[@"promptTokens"]] && [summary[@"reservedOutputTokens"] intValue] == 204);
        assert(![engine preflightMessages:messages tools:@"[]" reservedOutputTokens:0 error:&error]);
        error = nil;
        assert(![engine preflightMessages:messages tools:@"[]" reservedOutputTokens:4096 error:&error]);
        error = nil;
        assert(![engine preflightMessages:@"[]" tools:@"[]" reservedOutputTokens:1024 error:&error]);
        error = nil;
        NSMutableString *longText = [NSMutableString string];
        for (int i = 0; i < 12000; ++i) [longText appendString:@" token"];
        NSData *data = [NSJSONSerialization dataWithJSONObject:@[@{@"role":@"user",@"content":longText},@{@"role":@"assistant",@"content":@"Preserve this old exchange"},@{@"role":@"user",@"content":@"Continue"}] options:0 error:&error];
        NSString *large = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        NSDictionary *oversized = [engine preflightMessages:large tools:@"[]" reservedOutputTokens:1024 error:&error];
        assert(oversized && !error && [oversized[@"promptTokens"] unsignedLongLongValue] > 3072);
        __block BOOL emitted = NO;
        assert(![engine completeMessages:large tools:@"[]" onText:^(NSString *text) { emitted = YES; } error:&error]);
        assert(!emitted && [error.domain isEqual:@"LocalInference"] && error.code == 4);
        assert([error.userInfo[@"promptTokens"] isEqual:oversized[@"promptTokens"]]);
        error = nil;
        assert([oversized isEqual:[engine preflightMessages:large tools:@"[]" reservedOutputTokens:1024 error:&error]]);
        [engine unload];
        puts("MVLlama preflight: exact template/tools, explicit reserve, no silent history removal, overflow before inference passed");
    }
}
