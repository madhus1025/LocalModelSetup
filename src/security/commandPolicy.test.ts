import { describe, expect, it } from "vitest";
import { CommandPolicy } from "./commandPolicy";

describe("CommandPolicy", () => {
  const policy = new CommandPolicy();

  it("allows local build and test commands", () => {
    expect(policy.assess("npm test").decision).toBe("allow");
    expect(policy.assess("./gradlew test").decision).toBe("allow");
    expect(policy.assess("git --no-pager diff").decision).toBe("allow");
  });

  it("requires confirmation for destructive and network operations", () => {
    expect(policy.assess("rm -rf build").decision).toBe("confirm");
    expect(policy.assess("git push origin feature").decision).toBe("confirm");
    expect(policy.assess("curl https://example.com/upload").decision).toBe(
      "confirm"
    );
    expect(policy.assess("python -c 'print(1)'").decision).toBe("confirm");
    expect(policy.assess("./custom-script").decision).toBe("confirm");
  });

  it("denies obfuscated command construction", () => {
    expect(policy.assess("echo ${payload@P}").decision).toBe("deny");
    expect(policy.assess("eval \"$command\"").decision).toBe("deny");
    expect(policy.assess("echo ZWNobyBoaQ== | base64 -d | sh").decision).toBe(
      "deny"
    );
    expect(policy.assess("npm test\nrm -rf src").decision).toBe("deny");
  });

  it("requires approval for compound commands", () => {
    expect(policy.assess("npm test && npm run build").decision).toBe(
      "confirm"
    );
    expect(policy.assess("ls; mv package.json package.bak").decision).toBe(
      "confirm"
    );
  });
});
