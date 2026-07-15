const TOKEN_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]{8,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{12,}/g,
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  /gh[opusr]_[A-Za-z0-9]{12,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(?:API_KEY|ACCESS_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CREDENTIAL|AUTH(?:ORIZATION)?|COOKIE)/i.test(name)) continue;
    if (!value || value.length < 8) continue;
    output = output.split(value).join(`<redacted:${name}>`);
  }
  for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, '<redacted:secret>');
  return output;
}
