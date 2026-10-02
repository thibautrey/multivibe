#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/// Methods except cancel are confined to one serial inference queue.
@interface MVLlama : NSObject
- (BOOL)loadPath:(NSString *)path contextSize:(int)contextSize error:(NSError **)error;
- (nullable NSString *)completeMessages:(NSString *)messages tools:(NSString *)tools
                              onText:(void (^)(NSString *))onText error:(NSError **)error;
/// Exact template/tool-aware token measurement; does not decode, sample, or mutate the KV cache.
/// Oversized prompts return their measurements so callers can compact before generation.
- (nullable NSDictionary<NSString *, NSNumber *> *)preflightMessages:(NSString *)messages tools:(NSString *)tools
                                                reservedOutputTokens:(int)reservedOutputTokens error:(NSError **)error;
/// Explicit generation budget for bounded auxiliary calls; the compatibility overload reserves 1024.
- (nullable NSString *)completeMessages:(NSString *)messages tools:(NSString *)tools
                  reservedOutputTokens:(int)reservedOutputTokens onText:(void (^)(NSString *))onText error:(NSError **)error;
- (void)cancel;
- (void)resetCancellation;
- (void)unload;
@end
NS_ASSUME_NONNULL_END
