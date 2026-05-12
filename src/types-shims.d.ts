declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    cwd?: string;
    hasUI: boolean;
    ui: {
      notify(message: string, level: "info" | "warning" | "error" | "success" | string): void;
      confirm(title: string, message: string): Promise<boolean>;
    };
  }

  export interface ExtensionAPI {
    on(
      eventName: "session_start" | "tool_call" | string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>,
    ): void;
  }
}

declare module "picomatch" {
  export interface PicomatchOptions {
    dot?: boolean;
  }

  export default function picomatch(
    pattern: string,
    options?: PicomatchOptions,
  ): (value: string) => boolean;
}
