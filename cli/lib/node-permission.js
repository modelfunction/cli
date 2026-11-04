// Permission Model flag renamed across Node versions: --experimental-permission
// in 20–23.4, --permission from 23.5. Using the wrong one makes exec fail with
// "bad option" on Node 20/22 even though the model itself is available.
export function permissionFlag(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 5) ? "--permission" : "--experimental-permission";
}
