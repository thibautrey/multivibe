#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/// Methods except cancel are confined to one serial inference queue.
@interface MVLlama : NSObject
- (BOOL)loadPath:(NSString *)path contextSize:(int)contextSize error:(NSError **)error;
- (nullable NSString *)completeMessages:(NSString *)messages tools:(NSString *)tools
                              onText:(void (^)(NSString *))onText error:(NSError **)error;
- (void)cancel;
- (void)resetCancellation;
- (void)unload;
@end
NS_ASSUME_NONNULL_END
