// SPDX-License-Identifier: Apache-2.0
#include "Hardening.h"
#include <sys/types.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <stdlib.h>
#include <fcntl.h>

int multivibe_harden_process(void) {
    struct rlimit core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &core) != 0) return -1;
    struct kinfo_proc info = {0};
    size_t size = sizeof(info);
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || (info.kp_proc.p_flag & P_TRACED)) return -1;
    if (ptrace(PT_DENY_ATTACH, 0, 0, 0) != 0) return -1;
    // Third-party inference libraries must not emit request content to inherited log streams.
    int nullfd = open("/dev/null", O_WRONLY);
    if (nullfd < 0) return -1;
    if (dup2(nullfd, STDOUT_FILENO) < 0 || dup2(nullfd, STDERR_FILENO) < 0) { close(nullfd); return -1; }
    if (nullfd > STDERR_FILENO) close(nullfd);
    return 0;
}
