// Preloaded into a probe child process to model the unsafe ordering: the
// CopilotKit runtime initialises, and so latches its telemetry setting, before
// the application's guard has had any chance to run.
import '@copilotkit/runtime/v2';
