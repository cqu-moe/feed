export type SourceValidationSnapshot = {
  id: string;
  configVersion: number;
  validationState: string;
};

export type ValidationTaskSnapshot = {
  state: string;
  error?: string | null;
};

export async function readValidationSnapshot<T extends SourceValidationSnapshot, U extends ValidationTaskSnapshot>(
  readSource: () => Promise<T>,
  readTask: () => Promise<U>,
): Promise<{ source: T; task: U }> {
  const [source, task] = await Promise.all([readSource(), readTask()]);
  // Task and source state are committed and read independently. After a terminal task,
  // refresh the source once so a concurrently stale draft read cannot hide the verified result.
  // A still-draft refresh remains terminal for this poll and represents an older task.
  if (task.state === 'succeeded' && source.validationState !== 'verified') {
    return { source: await readSource(), task };
  }
  return { source, task };
}
