#import <AppKit/AppKit.h>
#include <stdlib.h>
#include <unistd.h>

static NSURL *morkaExecutable(NSURL *url, NSString *version) {
    if (!url) return nil;
    NSBundle *bundle = [NSBundle bundleWithURL:url];
    if (![bundle.bundleIdentifier hasPrefix:@"local.morka.runtime."] &&
        ![bundle.bundleIdentifier isEqualToString:@"local.morka"]) return nil;
    NSURL *launcher = [bundle.resourceURL URLByAppendingPathComponent:@"app/dist/instances/MorkaProject"];
    if (!launcher || ![NSFileManager.defaultManager isExecutableFileAtPath:launcher.path]) return nil;
    if (version) {
        NSURL *manifestURL = [bundle URLForResource:@"morka-runtime" withExtension:@"json"];
        NSData *data = manifestURL ? [NSData dataWithContentsOfURL:manifestURL] : nil;
        NSDictionary *manifest = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        if (![manifest isKindOfClass:NSDictionary.class] || ![version isEqual:manifest[@"version"]]) return nil;
    }
    NSURL *executable = bundle.executableURL;
    return executable && [NSFileManager.defaultManager isExecutableFileAtPath:executable.path] ? executable : nil;
}

static int showError(NSString *message) {
    [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApplication.sharedApplication activateIgnoringOtherApps:YES];
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Could not open the Morka project";
    alert.informativeText = message;
    [alert runModal];
    return 1;
}

int main(void) {
    @autoreleasepool {
        NSURL *configURL = [NSBundle.mainBundle URLForResource:@"morka-launch" withExtension:@"json"];
        NSData *data = configURL ? [NSData dataWithContentsOfURL:configURL] : nil;
        NSDictionary *config = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        if (![config isKindOfClass:NSDictionary.class]) {
            return showError(@"Open the project from Morka to recreate its launcher.");
        }
        NSString *repository = config[@"repository"];
        NSString *host = config[@"host"];
        NSString *version = config[@"runtimeVersion"];
        if (![repository isKindOfClass:NSString.class] || !repository.isAbsolutePath ||
            ![host isKindOfClass:NSString.class] || !host.isAbsolutePath ||
            (version && ![version isKindOfClass:NSString.class])) {
            return showError(@"Open the project from Morka to recreate its launcher.");
        }

        NSURL *executable = morkaExecutable([NSURL fileURLWithPath:host isDirectory:YES], version);
        if (!executable) {
            NSString *identifier = version ? [@"local.morka.runtime." stringByAppendingString:version] : @"local.morka";
            NSURL *installed = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:identifier];
            executable = morkaExecutable(installed, version);
        }
        if (!executable) {
            return showError(version ? [NSString stringWithFormat:@"Install and open Morka %@, then open this project from Morka.", version] :
                @"Install Morka in Applications, then open this project again.");
        }

        NSString *argument = [@"--morka-project=" stringByAppendingString:repository];
        const char *path = executable.fileSystemRepresentation;
        char *arguments[] = { (char *)path, (char *)argument.fileSystemRepresentation, NULL };
        // Launch Services can inherit the environment of the shell that opened the launcher.
        unsetenv("ELECTRON_RUN_AS_NODE");
        unsetenv("MORKA_INSTALL_APP");
        unsetenv("MORKA_LOCAL_NODE");
        unsetenv("MORKA_LOCAL_NPM");
        unsetenv("MORKA_NPM_KIT");
        unsetenv("MORKA_DESKTOP_TOOLCHAIN");
        execv(path, arguments);
        return showError(@"Open Morka and try launching the project from there.");
    }
}
