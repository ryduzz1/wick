// macOS capture, input, window listing and hotkeys for wick-platform.
//
// Built by build.rs with ARC. Every function is called from Rust through the
// C ABI declared in src/macos.rs.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

typedef void (*wick_frame_cb)(void *ctx, const uint8_t *data, size_t width, size_t height, size_t stride);
typedef void (*wick_hotkey_cb)(void *ctx);

static char *copy_c_string(NSString *s) {
    const char *utf8 = s.UTF8String ?: "";
    size_t n = strlen(utf8) + 1;
    char *out = malloc(n);
    memcpy(out, utf8, n);
    return out;
}

void wick_mac_free(char *p) { free(p); }

// MARK: - Windows

static CGFloat titlebar_height(void) {
    NSRect content = NSMakeRect(0, 0, 500, 500);
    NSWindowStyleMask mask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    NSRect frame = [NSWindow frameRectForContentRect:content styleMask:mask];
    return frame.size.height - content.size.height;
}

static BOOL covers_a_display(CGRect r) {
    uint32_t count = 0;
    CGDirectDisplayID ids[16];
    if (CGGetActiveDisplayList(16, ids, &count) != kCGErrorSuccess) return NO;
    for (uint32_t i = 0; i < count; i++) {
        if (CGRectEqualToRect(CGRectIntegral(CGDisplayBounds(ids[i])), CGRectIntegral(r))) return YES;
    }
    return NO;
}

// Returns a JSON array of on-screen windows, front to back. Free with wick_mac_free.
char *wick_mac_list_windows(void) {
    @autoreleasepool {
        CFArrayRef list = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
        NSArray *windows = CFBridgingRelease(list);
        CGFloat bar = titlebar_height();
        NSMutableArray *out = [NSMutableArray array];
        for (NSDictionary *w in windows) {
            CGRect r;
            if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &r)) continue;
            NSInteger layer = [w[(id)kCGWindowLayer] integerValue];
            CGRect client = r;
            if (layer == 0 && !covers_a_display(r) && r.size.height > bar) {
                client.origin.y += bar;
                client.size.height -= bar;
            }
            [out addObject:@{
                @"id" : w[(id)kCGWindowNumber] ?: @0,
                @"pid" : w[(id)kCGWindowOwnerPID] ?: @0,
                @"owner" : w[(id)kCGWindowOwnerName] ?: @"",
                @"title" : w[(id)kCGWindowName] ?: @"",
                @"layer" : @(layer),
                @"bounds" : @{@"x" : @(r.origin.x), @"y" : @(r.origin.y), @"w" : @(r.size.width), @"h" : @(r.size.height)},
                @"client" : @{@"x" : @(client.origin.x), @"y" : @(client.origin.y), @"w" : @(client.size.width), @"h" : @(client.size.height)},
            }];
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
        return copy_c_string([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    }
}

// MARK: - Permissions

int wick_mac_screen_permission(void) { return CGPreflightScreenCaptureAccess() ? 1 : 0; }

int wick_mac_accessibility_permission(int prompt) {
    NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt : @(prompt != 0)};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options) ? 1 : 0;
}

void wick_mac_request_screen_permission(void) { CGRequestScreenCaptureAccess(); }

// MARK: - Capture

@interface WickCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, assign) wick_frame_cb callback;
@property(nonatomic, assign) void *context;
@end

@implementation WickCapture

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(buffer)) return;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, false);
    if (attachments && CFArrayGetCount(attachments) > 0) {
        NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
        NSNumber *status = info[SCStreamFrameInfoStatus];
        if (status && status.integerValue != SCFrameStatusComplete) return;
    }
    CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(buffer);
    if (!pixels) return;
    CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
    const uint8_t *base = CVPixelBufferGetBaseAddress(pixels);
    if (base) {
        self.callback(self.context, base, CVPixelBufferGetWidth(pixels), CVPixelBufferGetHeight(pixels),
                      CVPixelBufferGetBytesPerRow(pixels));
    }
    CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
}

@end

static char *describe(NSError *error, NSString *fallback) {
    return copy_c_string(error.localizedDescription ?: fallback);
}

// Starts capturing one window. Returns an opaque handle, or NULL with *error set
// (free it with wick_mac_free).
void *wick_mac_capture_start(uint32_t window_id, uint32_t width, uint32_t height, uint32_t fps,
                             wick_frame_cb callback, void *context, char **error) {
    @autoreleasepool {
        __block SCShareableContent *content = nil;
        __block NSError *contentError = nil;
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                                   onScreenWindowsOnly:YES
                                                     completionHandler:^(SCShareableContent *c, NSError *e) {
                                                       content = c;
                                                       contentError = e;
                                                       dispatch_semaphore_signal(done);
                                                     }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
            *error = copy_c_string(@"Timed out asking macOS for the window list.");
            return NULL;
        }
        if (!content) {
            *error = describe(contentError, @"macOS didn't allow screen capture. Check Screen Recording permission.");
            return NULL;
        }
        SCWindow *target = nil;
        for (SCWindow *w in content.windows) {
            if (w.windowID == window_id) {
                target = w;
                break;
            }
        }
        if (!target) {
            *error = copy_c_string(@"The window closed before capture started.");
            return NULL;
        }

        SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
        SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
        config.width = MAX(width, 2);
        config.height = MAX(height, 2);
        config.minimumFrameInterval = CMTimeMake(1, (int32_t)MAX(fps, 1));
        config.pixelFormat = kCVPixelFormatType_32BGRA;
        config.colorSpaceName = kCGColorSpaceSRGB;
        config.showsCursor = NO;
        config.queueDepth = 3;

        WickCapture *capture = [[WickCapture alloc] init];
        capture.callback = callback;
        capture.context = context;
        capture.queue = dispatch_queue_create("dev.wick.capture", DISPATCH_QUEUE_SERIAL);
        capture.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:capture];

        NSError *addError = nil;
        if (![capture.stream addStreamOutput:capture
                                        type:SCStreamOutputTypeScreen
                          sampleHandlerQueue:capture.queue
                                       error:&addError]) {
            *error = describe(addError, @"Couldn't start the capture stream.");
            return NULL;
        }

        __block NSError *startError = nil;
        dispatch_semaphore_t started = dispatch_semaphore_create(0);
        [capture.stream startCaptureWithCompletionHandler:^(NSError *e) {
          startError = e;
          dispatch_semaphore_signal(started);
        }];
        if (dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
            *error = copy_c_string(@"Timed out starting capture.");
            return NULL;
        }
        if (startError) {
            *error = describe(startError, @"Couldn't start capture.");
            return NULL;
        }
        return (__bridge_retained void *)capture;
    }
}

// Stops a capture and waits until no more frames will be delivered.
void wick_mac_capture_stop(void *handle) {
    if (!handle) return;
    WickCapture *capture = (__bridge_transfer WickCapture *)handle;
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    [capture.stream stopCaptureWithCompletionHandler:^(NSError *e) {
      dispatch_semaphore_signal(stopped);
    }];
    dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    // Drain any frame callback already queued.
    dispatch_sync(capture.queue, ^{
                  });
}

// MARK: - Input

static CGPoint cursor_location(void) {
    CGEventRef e = CGEventCreate(NULL);
    CGPoint p = CGEventGetLocation(e);
    CFRelease(e);
    return p;
}

// Tags Wick's own events so the input listener can leave them out.
#define WICK_EVENT_TAG 0x5749434B

static int post(CGEventRef e) {
    if (!e) return 0;
    CGEventSetIntegerValueField(e, kCGEventSourceUserData, WICK_EVENT_TAG);
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
    return 1;
}

int wick_mac_mouse_move(double x, double y) {
    return post(CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(x, y), kCGMouseButtonLeft));
}

int wick_mac_mouse_move_relative(double dx, double dy) {
    CGPoint p = cursor_location();
    CGEventRef e = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(p.x + dx, p.y + dy), kCGMouseButtonLeft);
    if (!e) return 0;
    CGEventSetIntegerValueField(e, kCGMouseEventDeltaX, (int64_t)llround(dx));
    CGEventSetIntegerValueField(e, kCGMouseEventDeltaY, (int64_t)llround(dy));
    return post(e);
}

// button: 0 left, 1 right, 2 middle.
int wick_mac_mouse_button(int button, int down) {
    CGEventType type;
    CGMouseButton which;
    switch (button) {
        case 0:
            type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
            which = kCGMouseButtonLeft;
            break;
        case 1:
            type = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
            which = kCGMouseButtonRight;
            break;
        default:
            type = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
            which = kCGMouseButtonCenter;
            break;
    }
    return post(CGEventCreateMouseEvent(NULL, type, cursor_location(), which));
}

int wick_mac_key(uint16_t code, int down) {
    return post(CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code, down != 0));
}

// MARK: - Hotkey

static CFMachPortRef hotkey_tap = NULL;
static uint16_t hotkey_code = 0;
static wick_hotkey_cb hotkey_callback = NULL;
static void *hotkey_context = NULL;

static CGEventRef hotkey_event(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (hotkey_tap) CGEventTapEnable(hotkey_tap, true);
        return event;
    }
    if (type == kCGEventKeyDown &&
        CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == hotkey_code &&
        CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) == 0) {
        hotkey_callback(hotkey_context);
    }
    return event;
}

// Watches for one key system-wide. Needs Accessibility permission. Returns 1 on success.
int wick_mac_hotkey_start(uint16_t code, wick_hotkey_cb callback, void *context) {
    if (hotkey_tap) return 1;
    hotkey_code = code;
    hotkey_callback = callback;
    hotkey_context = context;
    hotkey_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
                                  CGEventMaskBit(kCGEventKeyDown), hotkey_event, NULL);
    if (!hotkey_tap) return 0;
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, hotkey_tap, 0);
    [NSThread detachNewThreadWithBlock:^{
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
      CGEventTapEnable(hotkey_tap, true);
      CFRunLoopRun();
    }];
    return 1;
}

// MARK: - Input listener

// Hears the person's clicks and key presses for recordings. It passes every
// event through unchanged; it uses a default (not listen-only) tap so the
// Accessibility permission Wick already has is enough.
// kind: 0 key (code = key code), 1 mouse button (code 0 left, 1 right, 2
// middle), 2 mouse motion (dx and dy are the raw deltas, which still arrive
// when a game locks the cursor for camera turns).
typedef void (*wick_input_cb)(void *context, int kind, int code, int down, double x, double y, double dx, double dy);

static CFMachPortRef listen_tap = NULL;
static volatile int listen_on = 0;
static wick_input_cb listen_callback = NULL;
static void *listen_context = NULL;

static CGEventRef listen_event(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (listen_tap && listen_on) CGEventTapEnable(listen_tap, true);
        return event;
    }
    if (!listen_on || CGEventGetIntegerValueField(event, kCGEventSourceUserData) == WICK_EVENT_TAG) return event;
    CGPoint p = CGEventGetLocation(event);
    switch (type) {
    case kCGEventKeyDown:
    case kCGEventKeyUp:
        listen_callback(listen_context, 0, (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode),
                        type == kCGEventKeyDown, 0, 0, 0, 0);
        break;
    case kCGEventFlagsChanged: {
        // Modifier keys arrive as flag changes; left and right map to one name.
        int code = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        CGEventFlags flags = CGEventGetFlags(event);
        CGEventFlags mask = 0;
        switch (code) {
        case 56: case 60: code = 56; mask = kCGEventFlagMaskShift; break;
        case 59: case 62: code = 59; mask = kCGEventFlagMaskControl; break;
        case 58: case 61: code = 58; mask = kCGEventFlagMaskAlternate; break;
        case 55: case 54: code = 55; mask = kCGEventFlagMaskCommand; break;
        }
        if (mask) listen_callback(listen_context, 0, code, (flags & mask) != 0, 0, 0, 0, 0);
        break;
    }
    case kCGEventLeftMouseDown:
    case kCGEventLeftMouseUp:
        listen_callback(listen_context, 1, 0, type == kCGEventLeftMouseDown, p.x, p.y, 0, 0);
        break;
    case kCGEventRightMouseDown:
    case kCGEventRightMouseUp:
        listen_callback(listen_context, 1, 1, type == kCGEventRightMouseDown, p.x, p.y, 0, 0);
        break;
    case kCGEventOtherMouseDown:
    case kCGEventOtherMouseUp:
        if (CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber) == 2)
            listen_callback(listen_context, 1, 2, type == kCGEventOtherMouseDown, p.x, p.y, 0, 0);
        break;
    case kCGEventMouseMoved:
    case kCGEventLeftMouseDragged:
    case kCGEventRightMouseDragged:
    case kCGEventOtherMouseDragged:
        listen_callback(listen_context, 2, 0, 0, p.x, p.y,
                        (double)CGEventGetIntegerValueField(event, kCGMouseEventDeltaX),
                        (double)CGEventGetIntegerValueField(event, kCGMouseEventDeltaY));
        break;
    default:
        break;
    }
    return event;
}

// Starts (on = 1) or pauses (on = 0) the listener. Returns 1 on success.
int wick_mac_listen(int on, wick_input_cb callback, void *context) {
    if (!on) {
        listen_on = 0;
        if (listen_tap) CGEventTapEnable(listen_tap, false);
        return 1;
    }
    listen_callback = callback;
    listen_context = context;
    if (!listen_tap) {
        CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
                           CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventMouseMoved) |
                           CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged) |
                           CGEventMaskBit(kCGEventOtherMouseDragged) |
                           CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
                           CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp) |
                           CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp);
        listen_tap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap, kCGEventTapOptionDefault, mask,
                                      listen_event, NULL);
        if (!listen_tap) return 0;
        CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, listen_tap, 0);
        [NSThread detachNewThreadWithBlock:^{
          CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
          CFRunLoopRun();
        }];
    }
    listen_on = 1;
    CGEventTapEnable(listen_tap, true);
    return 1;
}
