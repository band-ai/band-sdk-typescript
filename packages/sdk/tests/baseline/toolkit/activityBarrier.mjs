// Run by native Bash: GETs argv[2], sending argv[4] as header argv[3], and exits once the harness answers.
import http from "node:http";

const [, , url, header, marker] = process.argv;
await new Promise((resolve, reject) => {
  http.get(url, { headers: { [header]: marker } }, (response) => {
    response.resume();
    response.on("end", resolve);
  }).on("error", reject);
});
