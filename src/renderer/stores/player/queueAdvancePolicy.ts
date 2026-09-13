export const LISTEN_TOGETHER_QUEUE_ID = 'listen-together';
export const PERSONAL_FM_QUEUE_ID = 'personal-fm';

export type QueueAdvanceAuthority = 'owner' | 'listener' | 'fm' | 'unknown';

export const resolveQueueAdvanceAuthority = (options: {
  queueId: string | number | null | undefined;
  personalFmQueueId: string;
  listenTogetherQueueId: string;
}): QueueAdvanceAuthority => {
  const id = String(options.queueId ?? '');
  if (id === options.personalFmQueueId) return 'fm';
  if (id === options.listenTogetherQueueId) return 'listener';
  if (!id) return 'unknown';
  return 'owner';
};

export const canPrepareGaplessTransition = (options: {
  authority: QueueAdvanceAuthority;
  autoNextSuppressed: boolean;
}): boolean => {
  const { authority, autoNextSuppressed } = options;
  if (autoNextSuppressed) return false;
  if (authority === 'listener' || authority === 'fm') return false;
  return true;
};
