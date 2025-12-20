export function operatorHandoffMessage(
  customerName: string,
  operatorName: string,
): string {
  return `Ol\u00e1, ${customerName}. Meu nome \u00e9 ${operatorName} e irei dar continuidade ao seu atendimento.\u{1F609}\u2764`;
}

export function stillInChatMessage(customerName: string): string {
  return `Ol\u00e1, ${customerName}. Voc\u00ea ainda est\u00e1 no chat?`;
}

export function inactivityCloseMessage(customerName: string): string {
  return `Ol\u00e1, ${customerName}. Identificamos que voc\u00ea est\u00e1 inativo e seu chat ser\u00e1 encerrado por inatividade.`;
}
