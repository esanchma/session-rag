import { mkdirSync } from "node:fs";

const result = await Bun.build({
  entrypoints: ["src/client.tsx"],
  target: "browser",
  minify: true,
  write: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}

const bundle = result.outputs.find((output) => output.path.endsWith(".js"));
if (!bundle) throw new Error("Preact build did not produce a JavaScript bundle");
mkdirSync("dist", { recursive: true });
await Bun.write("dist/client.bundle.js", bundle);
