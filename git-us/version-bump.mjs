import fs from "fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));

versions[manifest.minAppVersion] = manifest.version;
fs.writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
console.log("Updated versions.json");
