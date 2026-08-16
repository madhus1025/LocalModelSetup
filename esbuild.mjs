import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.env.NODE_ENV === "production";

const extensionOptions = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  sourcemap: true,
  minify: production,
  logLevel: "info"
};

const webviewOptions = {
  entryPoints: ["src/ui/webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  outfile: "dist/webview.js",
  sourcemap: true,
  minify: production,
  logLevel: "info"
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions)
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching extension and webview sources.");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions)
  ]);
}
