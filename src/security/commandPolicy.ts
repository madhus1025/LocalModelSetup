export type CommandDecision = "allow" | "confirm" | "deny";

export interface CommandAssessment {
  decision: CommandDecision;
  severity: "caution" | "danger";
  reasons: string[];
}

const forbiddenPatterns: Array<[RegExp, string]> = [
  [/\r|\n/, "Multi-line shell commands are prohibited."],
  [/\$\{[^}]+@P\}/, "Shell parameter prompt expansion is prohibited."],
  [/\$\{![^}]+\}/, "Indirect shell expansion is prohibited."],
  [/(^|[;&|]\s*)eval(?:\s|$)/i, "Dynamic eval execution is prohibited."],
  [
    /(?:base64|xxd)\b[^|]*\|\s*(?:sh|bash|zsh)\b/i,
    "Encoded command execution is prohibited."
  ],
  [
    /\b(?:mkfs|fdisk|gparted)\b/i,
    "Raw filesystem and partition operations are prohibited."
  ],
  [
    /\bdd\b[^;\n]*(?:of=\/dev\/|if=\/dev\/)/i,
    "Raw device reads or writes are prohibited."
  ]
];

const confirmationPatterns: Array<[RegExp, string]> = [
  [
    /&&|\|\||[;|]/,
    "Compound shell commands require explicit approval."
  ],
  [
    /\$\(|`/,
    "Shell command substitution requires explicit approval."
  ],
  [
    /(^|[;&|]\s*)(?:sudo|su)(?:\s|$)/i,
    "The command requests elevated privileges."
  ],
  [
    /(^|[;&|]\s*)(?:rm|rmdir|unlink)(?:\s|$)/i,
    "The command deletes filesystem content."
  ],
  [
    /(^|[;&|]\s*)(?:chmod|chown)\b[^;\n]*\s-R\b/i,
    "The command recursively changes filesystem permissions or ownership."
  ],
  [
    /\b(?:curl|wget|ssh|scp|sftp|ftp|nc|ncat|rsync)\b/i,
    "The command can access or transmit data over the network."
  ],
  [
    /\bgit\s+(?:push|fetch|pull|clone|submodule)\b/i,
    "The Git operation communicates with a remote."
  ],
  [
    /\bgit\s+(?:commit|merge|rebase|reset|clean|checkout|switch|tag|stash)\b/i,
    "The Git operation changes repository history or working state."
  ],
  [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|publish|login|logout)\b/i,
    "The package-manager operation changes dependencies, credentials, or published artifacts."
  ],
  [
    /\b(?:pip|pip3|uv)\s+(?:install|uninstall|publish)\b/i,
    "The Python package operation changes the environment or publishes artifacts."
  ],
  [
    /\b(?:brew|apt|apt-get|dnf|yum|pacman)\s+(?:install|remove|upgrade|update)\b/i,
    "The command changes system packages."
  ],
  [
    /\b(?:deploy|deployment|release|publish)\b/i,
    "The command appears to publish or deploy software."
  ],
  [
    /\b(?:security\s+find-|printenv|env\s*$|keychain|credentials?)\b/i,
    "The command may expose credentials or environment secrets."
  ],
  [
    /(?:\/|~\/)(?:\.ssh|\.aws|\.azure|\.gnupg|Library\/Keychains)\b/i,
    "The command accesses a credential-bearing location."
  ],
  [
    /(?:^|[\s])>{1,2}(?!\s*\/dev\/null\b)/,
    "The command redirects output and can modify files outside the reviewed edit workflow."
  ],
  [
    /(^|[;&|]\s*)(?:touch|cp|mv|mkdir|install|tee)(?:\s|$)/i,
    "The command directly changes filesystem content outside the reviewed edit workflow."
  ],
  [
    /\b(?:sed\s+-i|perl\s+-pi|python\d*\s+-c|node\s+-e)\b/i,
    "Inline code or in-place editing can bypass the reviewed edit workflow."
  ],
  [
    /(?:^|[\s])(?:~\/|\.\.\/|\/(?!dev\/null\b))/,
    "The command references a path outside the workspace-relative command boundary."
  ]
];

const autoApprovedPatterns: RegExp[] = [
  /^\s*git\s+--no-pager\s+(?:status|diff|log|show|blame)\b/i,
  /^\s*git\s+(?:status|diff|log|show|blame)\b/i,
  /^\s*(?:npm|pnpm|yarn|bun)\s+(?:test|run)\b/i,
  /^\s*(?:pytest|python\d*\s+-m\s+pytest)\b/i,
  /^\s*(?:swift\s+(?:test|build)|xcodebuild)\b/i,
  /^\s*(?:\.\/)?gradlew?\s+(?:test|check|build|assemble)\b/i,
  /^\s*(?:mvnw?|\.\/mvnw)\s+(?:test|verify|package)\b/i,
  /^\s*dotnet\s+(?:test|build)\b/i,
  /^\s*cargo\s+(?:test|check|build|clippy|fmt)\b/i,
  /^\s*go\s+(?:test|build|vet)\b/i,
  /^\s*(?:make|cmake\s+--build)\b/i,
  /^\s*(?:rg|grep|head|tail|wc|file|pwd|ls|which|command\s+-v)\b/i
];

export class CommandPolicy {
  public assess(command: string): CommandAssessment {
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return {
        decision: "deny",
        severity: "danger",
        reasons: ["Empty commands cannot be executed."]
      };
    }
    const forbidden = matchingReasons(trimmed, forbiddenPatterns);
    if (forbidden.length > 0) {
      return {
        decision: "deny",
        severity: "danger",
        reasons: forbidden
      };
    }
    const confirmations = matchingReasons(trimmed, confirmationPatterns);
    if (confirmations.length > 0) {
      return {
        decision: "confirm",
        severity: "danger",
        reasons: confirmations
      };
    }
    if (!autoApprovedPatterns.some((pattern) => pattern.test(trimmed))) {
      return {
        decision: "confirm",
        severity: "caution",
        reasons: [
          "The command is not in the auto-approved read/build/test command set."
        ]
      };
    }
    return {
      decision: "allow",
      severity: "caution",
      reasons: []
    };
  }
}

function matchingReasons(
  command: string,
  patterns: Array<[RegExp, string]>
): string[] {
  return patterns.flatMap(([pattern, reason]) =>
    pattern.test(command) ? [reason] : []
  );
}
