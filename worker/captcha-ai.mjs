// Worker binding adapter. The equivalent REST payload was tested live three times.
// The downloading HTTP/browser client owns the temporary source-site session.
export const CAPTCHA_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

export async function recognizeDigits(ai, imageBytes, mime = 'image/jpeg') {
  const bytes = new Uint8Array(imageBytes);
  if (!mime.startsWith('image/') || !bytes.length || bytes.length > 1024 * 1024) {
    throw new Error('Expected a CAPTCHA image of at most 1 MiB');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await ai.run(CAPTCHA_MODEL, {
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Read the four digits in this image from left to right. Return exactly four ASCII digits, including any leading zero. No explanation.' },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${btoa(binary)}` } },
    ] }],
    temperature: 0,
    max_tokens: 16,
  });
  // Prefer the original text; the API's response convenience field may be a number.
  const digits = String(result.choices?.[0]?.message?.content ?? result.response ?? '').trim();
  if (!/^[0-9]{4}$/.test(digits)) throw new Error('AI did not return exactly four digits');
  return digits;
}
