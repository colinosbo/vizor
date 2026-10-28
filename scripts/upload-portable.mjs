// Only the manually dispatched, trusted release workflow calls this after verification.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
const result = JSON.parse(
  readFileSync("artifacts/portable-result.json", "utf8"),
);
const check = JSON.parse(
  readFileSync("artifacts/portable-smoke-result.json", "utf8"),
);
const id = process.env.VIZOR_RELEASE_ID;
const repository = process.env.GITHUB_REPOSITORY;
if (
  !/^\d+$/.test(id ?? "") ||
  repository !== "colinosbo/vizor" ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  !process.env.GITHUB_TOKEN
)
  throw new Error(
    "Release uploads require the trusted manual main-branch workflow.",
  );
if (
  !check.passed ||
  !check.noNodeOnPath ||
  result.sourceCommit !== process.env.VIZOR_RELEASE_COMMIT
)
  throw new Error(
    "This package has not passed the portable verification for the requested commit.",
  );
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "Vizor-portable-release",
  "X-GitHub-Api-Version": "2022-11-28",
};
const api = `https://api.github.com/repos/${repository}/releases/${id}`;
const response = await fetch(api, { headers });
if (!response.ok)
  throw new Error(`Release lookup failed (${response.status}).`);
const release = await response.json();
if (
  !release.draft ||
  release.tag_name !== `v${result.version}` ||
  release.target_commitish !== result.sourceCommit
)
  throw new Error(
    "Uploads require a matching draft release and exact source commit.",
  );
for (const file of [result.archive, `${result.archive}.sha256`]) {
  const name = basename(file);
  const upload = await fetch(
    `https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": file.endsWith(".sha256")
          ? "text/plain"
          : "application/octet-stream",
      },
      body: readFileSync(file),
    },
  );
  if (!upload.ok)
    throw new Error(`Release asset upload failed (${upload.status}).`);
  console.log(`Uploaded verified ${name} to the draft release.`);
}
