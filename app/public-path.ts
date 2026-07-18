export function resolvePublicPath(path: string, basePath: string): string {
  if (!path.startsWith("/")) {
    throw new TypeError("Public paths must begin with '/'.");
  }
  if (basePath === "/") return path;
  if (!basePath.startsWith("/") || !basePath.endsWith("/")) {
    throw new TypeError("The public base path must begin and end with '/'.");
  }
  return `${basePath.slice(0, -1)}${path}`;
}
