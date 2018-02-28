import * as fs from "fs";
import { JSDOM } from "jsdom";
import { join, resolve } from "path";
import { renderSync } from "sass";
import { URL } from "url";
import { drainExecuteQueue, initSandbox } from "../website/notebook";
import * as website from "../website/website";
import * as gendoc from "./gendoc";
import * as run from "./run";

// tslint:disable:no-reference
/// <reference path="deps/firebase/firebase.d.ts" />

const websiteRoot = run.root + "/build/website/";

async function fetch(url, options): Promise<Response> {
  if (/^\[a-z]+:|^[\\\/]{2}/.test(url)) {
    throw new Error("Absolute URLs not supported during page build");
  }
  const path = resolve(`${websiteRoot}/${url}`);
  console.log(`fetch: ${path}`);
  const data = fs.readFileSync(path);

  return {
    async arrayBuffer() { return data; },
    async text() { return data.toString("utf8"); }
  } as any as Response;
}

async function renderToHtmlWithJsdom(page: website.Page): Promise<string> {
  const window = new JSDOM("", {}).window;

  global["window"] = window;
  global["self"] = window;
  global["document"] = window.document;
  global["navigator"] = window.navigator;
  global["Node"] = window.Node;
  global["getComputedStyle"] = window.getComputedStyle;

  const { window: sbWindow } = new JSDOM("", {
    resources: "usable",
    runScripts: "dangerously",
    url: new URL(`file:///${__dirname}/../build/website/sandbox`).href,
    beforeParse(sbWindow: any) {
      sbWindow._parent = window;
      sbWindow.fetch = fetch;
    }
  });
  const sandboxScript =
    fs.readFileSync(`${__dirname}/../build/website/nb_sandbox.js`, "utf8");
  sbWindow.eval(sandboxScript);
  initSandbox(sbWindow);

  website.renderPage(page);
  await new Promise(res => window.addEventListener("load", res));
  await drainExecuteQueue();

  const bodyHtml = document.body.innerHTML;
  const html = website.getHTML(page.title, bodyHtml);
  return html;
}

async function writePages() {
  for (const page of website.pages) {
    console.log(`rendering: ${page.path}`);
    const html = await renderToHtmlWithJsdom(page);
    const fn = join(run.root, "build", page.path);
    fs.writeFileSync(fn, html);
  }
}

function scss(inFile, outFile) {
  const options = {
    file: inFile,
    includePaths: ["./website"],
  };
  const result = renderSync(options).css.toString("utf8");
  console.log("scss", inFile, outFile);
  fs.writeFileSync(outFile, result);
}

process.on("unhandledRejection", e => { throw e; });

(async() => {
  run.mkdir("build");
  run.mkdir("build/website");
  run.mkdir("build/website/docs");
  run.mkdir("build/website/notebook");
  run.mkdir("build/website/src"); // Needed for npy_test

  run.symlink(run.root + "/website/", "build/website/static");
  run.symlink(run.root + "/deps/data/", "build/website/data");
  // Needed for npy_test
  run.symlink(run.root + "/src/testdata/", "build/website/src/testdata");

  gendoc.writeJSON("build/website/docs.json");

  scss("website/main.scss", join(websiteRoot, "bundle.css"));

  await run.parcel("website/website_main.ts", "build/website");
  await run.parcel("website/nb_sandbox.ts", "build/website");

  // This needs to be run *after* parcel, because the notebook sandbox loads
  // nb_sandbox.js during page build.
  await writePages();

  console.log("Website built in", websiteRoot);

  // Firebase keeps network connections open, so we have force exit the process.
  process.exit(0);
})();
