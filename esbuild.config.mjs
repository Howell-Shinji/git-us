import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  platform: "node",
  external: ["obsidian", "electron", "path", "fs", "fs/promises", "os", "child_process"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js"
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
