export interface AuditSink {
  record(
    event: string,
    data: Record<string, string | number | boolean | string[] | null>
  ): void;
}

export const noOpAuditSink: AuditSink = {
  record: () => undefined
};
