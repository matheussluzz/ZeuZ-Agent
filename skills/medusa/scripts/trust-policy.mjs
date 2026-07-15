export const PUBLIC_TRACKED_TEMPLATES = new Set([
  '.env.example',
  'lamine.example.yaml',
  'templates/aws-athena-mcp/.env.example',
]);

const SENSITIVE_PATH = /(^|\/)(\.env(?:\..*)?|lamine(?:\.[^/]*)?\.ya?ml|\.npmrc|auth\.json|[^/]*(?:credentials?|secrets?)[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|jks))$/i;
const SECRET_SHAPE = /(?:nvapi-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET)\s*=\s*["']?(?!<|your-|example|replace|\$)[A-Za-z0-9_./+=-]{18,})/i;

export const portablePath = (path) => path.replaceAll('\\', '/').replace(/^\.\//, '');

export function isSensitivePath(path) {
  return SENSITIVE_PATH.test(portablePath(path));
}

export function isPublicTrackedTemplate(path) {
  return PUBLIC_TRACKED_TEMPLATES.has(portablePath(path));
}

export function containsSecretShape(content) {
  return SECRET_SHAPE.test(content);
}
