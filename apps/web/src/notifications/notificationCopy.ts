// Same tone as the relay's own server-side push copy
// (infra/relay/src/agentActivity/ApnsDeliveries.ts's `notificationForAggregate`):
// title is the thread name, body is a short status line naming the project.
export function notificationBody(input: {
  readonly headline: string;
  readonly projectTitle: string;
}): string {
  return `${input.headline}: ${input.projectTitle}`;
}
