const sensitiveKeyPattern =
  /(token|secret|password|passwd|credential|private[_-]?key|api[_-]?key|cookie|authorization)/i;

const textualSecretPatterns: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export interface SanitizedEnvironment {
  environment: NodeJS.ProcessEnv;
  removedValues: string[];
}

export function sanitizeEnvironment(
  source: NodeJS.ProcessEnv
): SanitizedEnvironment {
  const environment: NodeJS.ProcessEnv = {};
  const removedValues: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (sensitiveKeyPattern.test(key)) {
      if (value.length >= 6) {
        removedValues.push(value);
      }
      continue;
    }
    environment[key] = value;
  }
  return { environment, removedValues };
}

export class SecretRedactor {
  public constructor(private readonly knownSecretValues: readonly string[]) {}

  public redact(text: string): string {
    let redacted = text;
    for (const value of this.knownSecretValues) {
      if (value.length >= 6) {
        redacted = redacted.split(value).join("[REDACTED]");
      }
    }
    for (const pattern of textualSecretPatterns) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return redacted;
  }
}
