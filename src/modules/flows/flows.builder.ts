import type {
  Flow,
  FlowButton,
  FlowNode,
  TwilioFlowDefinition,
  TwilioTransition,
  TwilioWidget,
  TwilioWidgetProperties,
} from './flows.types';

// Constantes de layout - posicionamento organizado dos widgets no Twilio Studio
const LAYOUT = {
  // Posição inicial do Trigger
  TRIGGER_X: 0,
  TRIGGER_Y: 0,
  // Posição inicial do primeiro widget (abaixo do Trigger)
  START_X: 0,
  START_Y: 300,
  // Espaçamento vertical entre níveis de widgets
  VERTICAL_SPACING: 650,
  // Espaçamento horizontal entre widgets no mesmo nível
  HORIZONTAL_SPACING: 550,
  // Offset Y do split em relação ao widget de botões
  SPLIT_X_OFFSET: 0,
  SPLIT_Y_OFFSET: 420,
  MIN_MESSAGE_TO_SPLIT_GAP: 250,
  MIN_SPLIT_TO_CHILD_GAP: 250,
  TRANSFER_CLONE_Y_OFFSET: 240,
  // Posição X do widget de timeout (à esquerda)
  FALLBACK_X: 210,
} as const;

const DEFAULT_TIMEOUT = 3600;

export class FlowBuilder {
  private widgets: TwilioWidget[] = [];
  private nodeMap: Map<string, FlowNode> = new Map();
  private processedNodes: Set<string> = new Set();
  private nodePositions: Map<string, { x: number; y: number }> = new Map();
  private startNodeId: string = '';
  private transferIncomingSources: Map<string, string[]> = new Map();
  private transferPrimarySource: Map<string, string> = new Map();
  private transferCloneByEdge: Map<string, string> = new Map();
  private botInitWidgetName = 'bot_init';

  build(flow: Flow): TwilioFlowDefinition {
    this.widgets = [];
    this.nodeMap = new Map();
    this.processedNodes = new Set();
    this.nodePositions = new Map();
    this.startNodeId = flow.start_node_id;
    this.transferIncomingSources = new Map();
    this.transferPrimarySource = new Map();
    this.transferCloneByEdge = new Map();
    this.botInitWidgetName = this.getWidgetName('bot_init');

    // Mapear nodes por ID
    for (const node of flow.nodes) {
      this.nodeMap.set(node.id, node);
    }

    this.botInitWidgetName = this.getUniqueInternalWidgetName('bot_init');

    // Calcular posições organizadas
    this.calculatePositions(flow);
    this.prepareTransferClones(flow);

    // Criar widget Trigger
    this.createTriggerWidget();
    this.createBotInitWidget(flow);

    // Processar nodes em ordem de fluxo
    this.processNodeRecursive(flow.start_node_id);
    this.createFallbackWidgets();

    // Criar widgets de fallback no final
    return {
      description: flow.description || flow.name,
      flags: {
        allow_concurrent_calls: true,
      },
      initial_state: 'Trigger',
      states: this.widgets,
    };
  }

  private calculatePositions(flow: Flow): void {
    // Primeiro passo: calcular o nível MÁXIMO de cada nó (profundidade mais profunda)
    const allFinite = flow.nodes.every(
      (node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y),
    );
    const hasAnyNonZero = flow.nodes.some((node) => node.position.x !== 0 || node.position.y !== 0);

    // If the input already provides canvas positions, keep them 1:1 in Twilio Studio.
    if (allFinite && hasAnyNonZero) {
      for (const node of flow.nodes) {
        this.nodePositions.set(node.id, {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        });
      }
      return;
    }

    // Auto layout: tree-style layout to keep subtrees grouped and avoid crossed lines.
    const reachable = this.getReachableNodes(flow.start_node_id);
    const childrenByNodeId = new Map<string, string[]>();

    for (const node of flow.nodes) {
      if (!reachable.has(node.id)) continue;

      if (node.buttons) {
        const children = node.buttons
          .map((btn) => btn.nextNodeId)
          .filter((childId) => reachable.has(childId));
        childrenByNodeId.set(node.id, children);
        continue;
      }

      if (node.nextNodeId && reachable.has(node.nextNodeId)) {
        childrenByNodeId.set(node.id, [node.nextNodeId]);
        continue;
      }

      childrenByNodeId.set(node.id, []);
    }

    const widthCache = new Map<string, number>();
    const computing = new Set<string>();

    const getWidth = (nodeId: string): number => {
      const cached = widthCache.get(nodeId);
      if (cached) return cached;

      if (!reachable.has(nodeId)) return 1;
      if (computing.has(nodeId)) return 1;

      computing.add(nodeId);

      const node = this.nodeMap.get(nodeId);
      const children = childrenByNodeId.get(nodeId) || [];

      let width = 1;

      if (!node || children.length === 0) {
        width = 1;
      } else if (node.buttons) {
        width = 0;
        for (const childId of children) {
          width += getWidth(childId);
        }
        if (width < 1) width = 1;
      } else {
        width = getWidth(children[0] || '');
        if (!Number.isFinite(width) || width < 1) width = 1;
      }

      computing.delete(nodeId);
      widthCache.set(nodeId, width);
      return width;
    };

    const rootWidth = getWidth(flow.start_node_id);
    const rootCenterSlot = (rootWidth - 1) / 2;
    const placed = new Set<string>();

    const place = (nodeId: string, leftSlot: number, level: number): void => {
      if (!reachable.has(nodeId)) return;
      if (placed.has(nodeId)) return;
      placed.add(nodeId);

      const width = getWidth(nodeId);
      const centerSlot = leftSlot + (width - 1) / 2;

      this.nodePositions.set(nodeId, {
        x: Math.round(LAYOUT.START_X + (centerSlot - rootCenterSlot) * LAYOUT.HORIZONTAL_SPACING),
        y: Math.round(LAYOUT.START_Y + level * LAYOUT.VERTICAL_SPACING),
      });

      const node = this.nodeMap.get(nodeId);
      if (!node) return;

      if (node.buttons) {
        const children = childrenByNodeId.get(nodeId) || [];
        let currentLeft = leftSlot;

        for (const childId of children) {
          const childWidth = getWidth(childId);
          place(childId, currentLeft, level + 1);
          currentLeft += childWidth;
        }
        return;
      }

      const nextId = node.nextNodeId;
      if (nextId) {
        place(nextId, leftSlot, level + 1);
      }
    };

    place(flow.start_node_id, 0, 0);
  }

  private processNodeRecursive(nodeId: string): void {
    if (this.processedNodes.has(nodeId)) return;

    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    this.processedNodes.add(nodeId);
    this.processNode(node);

    if (node.buttons) {
      for (const btn of node.buttons) {
        this.processNodeRecursive(btn.nextNodeId);
      }
    } else if (node.nextNodeId) {
      this.processNodeRecursive(node.nextNodeId);
    }
  }

  private createTriggerWidget(): void {
    const firstWidgetName = this.botInitWidgetName;

    this.widgets.push({
      name: 'Trigger',
      type: 'trigger',
      properties: {
        offset: { x: LAYOUT.TRIGGER_X, y: LAYOUT.TRIGGER_Y },
      },
      transitions: [
        { event: 'incomingMessage' },
        { event: 'incomingCall' },
        { event: 'incomingConversationMessage', next: firstWidgetName },
        { event: 'incomingRequest' },
        { event: 'incomingParent' },
      ],
    });
  }

  private createBotInitWidget(flow: Flow): void {
    const nextWidgetName = this.getWidgetName(this.startNodeId);
    const startPosition = this.getNodePosition(this.startNodeId);

    this.widgets.push({
      name: this.botInitWidgetName,
      type: 'set-variables',
      properties: {
        offset: {
          x: startPosition.x - 270,
          y: startPosition.y - 110,
        },
        variables: [
          {
            type: 'json_object',
            value: flow.name,
            key: 'address',
          },
        ],
      },
      transitions: [{ event: 'next', next: nextWidgetName }],
    });
  }

  private createFallbackWidgets(): void {
    return;

    /*
    let maxX = Number.NEGATIVE_INFINITY;

    this.nodePositions.forEach((pos) => {
      if (pos.x > maxX) maxX = pos.x;
    });

    const hasPositions = Number.isFinite(maxX);
    const baseX = hasPositions ? maxX : LAYOUT.START_X;

    const startPosition = this.getNodePosition(this.startNodeId);
    let fallbackY = startPosition.y + LAYOUT.MIN_MESSAGE_TO_SPLIT_GAP;

    const startNode = this.nodeMap.get(this.startNodeId);
    if (startNode && startNode.type === "buttons") {
      const splitY = this.getButtonsSplitY(startNode, startPosition);
      fallbackY = splitY - 20;
    }

    const fallbackX = baseX + LAYOUT.FALLBACK_X;

    this.widgets.push({
      name: "timeout_handler",
      type: "send-message",
      properties: {
        offset: { x: Math.round(fallbackX), y: Math.round(fallbackY) },
        body: "Parece que você está ocupado. Se precisar de ajuda, envie uma nova mensagem a qualquer momento.",
        from: "{{flow.variables.address}}",
        to: "{{contact.channel.address}}",
        service: "{{trigger.message.InstanceSid}}",
        channel: "{{trigger.message.ChannelSid}}",
        message_type: "custom",
        attributes: '{\n"is_bot": "Mensagem do bot"\n}',
      },
      transitions: [{ event: "sent" }, { event: "failed" }],
    });
    */
  }

  private processNode(node: FlowNode): void {
    switch (node.type) {
      case 'message':
        this.createMessageWidget(node);
        break;
      case 'question':
        this.createQuestionWidget(node);
        break;
      case 'buttons':
        this.createButtonsWidget(node);
        break;
      case 'transfer':
        this.createTransferWidget(node);
        break;
    }
  }

  private getNodePosition(nodeId: string): { x: number; y: number } {
    return this.nodePositions.get(nodeId) || { x: LAYOUT.START_X, y: LAYOUT.START_Y };
  }

  private prepareTransferClones(flow: Flow): void {
    this.transferIncomingSources = new Map();
    this.transferPrimarySource = new Map();
    this.transferCloneByEdge = new Map();

    const reachable = this.getReachableNodes(flow.start_node_id);

    for (const node of flow.nodes) {
      if (!reachable.has(node.id)) continue;

      if (node.buttons) {
        for (const btn of node.buttons) {
          if (!reachable.has(btn.nextNodeId)) continue;
          const target = this.nodeMap.get(btn.nextNodeId);
          if (target?.type === 'transfer') {
            this.addTransferIncomingSource(btn.nextNodeId, node.id);
          }
        }
      }

      if (node.nextNodeId) {
        if (!reachable.has(node.nextNodeId)) continue;
        const target = this.nodeMap.get(node.nextNodeId);
        if (target?.type === 'transfer') {
          this.addTransferIncomingSource(node.nextNodeId, node.id);
        }
      }
    }

    for (const [transferNodeId, sources] of this.transferIncomingSources) {
      if (sources.length <= 1) continue;

      const transferPos = this.getNodePosition(transferNodeId);
      let primarySourceId = sources[0] || '';

      // Prefer the edge that comes directly from a "buttons" node (split option),
      // so the main transfer widget represents the direct button path.
      const buttonsSource = sources.find(
        (sourceId) => this.nodeMap.get(sourceId)?.type === 'buttons',
      );
      if (buttonsSource) {
        primarySourceId = buttonsSource;
      } else {
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const sourceId of sources) {
          const sourcePos = this.getNodePosition(sourceId);
          const distance = Math.abs(sourcePos.x - transferPos.x);
          if (distance < bestDistance) {
            bestDistance = distance;
            primarySourceId = sourceId;
          }
        }
      }

      if (!primarySourceId) continue;
      this.transferPrimarySource.set(transferNodeId, primarySourceId);

      for (const sourceId of sources) {
        if (sourceId === primarySourceId) continue;
        const cloneName = `${this.getWidgetName(transferNodeId)}__from_${this.getWidgetName(sourceId)}`;
        this.transferCloneByEdge.set(`${sourceId}=>${transferNodeId}`, cloneName);
      }
    }
  }

  private addTransferIncomingSource(transferNodeId: string, sourceNodeId: string): void {
    const existing = this.transferIncomingSources.get(transferNodeId) || [];
    if (!existing.includes(sourceNodeId)) {
      existing.push(sourceNodeId);
      this.transferIncomingSources.set(transferNodeId, existing);
    }
  }

  private resolveNextWidgetName(fromNodeId: string, toNodeId: string): string {
    const override = this.transferCloneByEdge.get(`${fromNodeId}=>${toNodeId}`);
    return override || this.getWidgetName(toNodeId);
  }

  private getReachableNodes(startNodeId: string): Set<string> {
    const visited = new Set<string>();

    const walk = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);

      const node = this.nodeMap.get(nodeId);
      if (!node) return;

      if (node.buttons) {
        for (const btn of node.buttons) {
          walk(btn.nextNodeId);
        }
        return;
      }

      if (node.nextNodeId) {
        walk(node.nextNodeId);
      }
    };

    walk(startNodeId);
    return visited;
  }

  private getButtonsSplitY(node: FlowNode, nodePosition: { x: number; y: number }): number {
    const desired = nodePosition.y + LAYOUT.SPLIT_Y_OFFSET;

    const childYs: number[] = [];
    if (node.buttons) {
      for (const btn of node.buttons) {
        const childPos = this.getNodePosition(btn.nextNodeId);
        if (Number.isFinite(childPos.y)) {
          childYs.push(childPos.y);
        }
      }
    }

    if (childYs.length === 0) return desired;

    const minChildY = Math.min(...childYs);
    if (!Number.isFinite(minChildY)) return desired;

    const minSplitY = nodePosition.y + LAYOUT.MIN_MESSAGE_TO_SPLIT_GAP;
    const maxSplitY = minChildY - LAYOUT.MIN_SPLIT_TO_CHILD_GAP;

    if (maxSplitY < minSplitY) return desired;

    return Math.min(Math.max(desired, minSplitY), maxSplitY);
  }

  private createMessageWidget(node: FlowNode): void {
    const widgetName = this.getWidgetName(node.id);
    const position = this.getNodePosition(node.id);
    const nextWidget = node.nextNodeId
      ? this.resolveNextWidgetName(node.id, node.nextNodeId)
      : undefined;

    const properties: TwilioWidgetProperties = {
      offset: position,
      from: '{{flow.variables.address}}',
      to: '{{contact.channel.address}}',
      service: '{{trigger.message.InstanceSid}}',
      channel: '{{trigger.message.ChannelSid}}',
      attributes: '{\n"is_bot": "Mensagem do bot"\n}',
    };

    // Se tem Content Template, usar content_template_sid
    if (node.contentTemplateSid) {
      properties.message_type = 'content_template';
      properties.content_sid = node.contentTemplateSid;
      properties.content_template_sid = node.contentTemplateSid;
      properties.body = node.content;
    } else {
      properties.message_type = 'custom';
      properties.body = node.content;
    }

    this.widgets.push({
      name: widgetName,
      type: 'send-message',
      properties,
      transitions: [{ event: 'sent', next: nextWidget }, { event: 'failed' }],
    });
  }

  private createQuestionWidget(node: FlowNode): void {
    const widgetName = this.getWidgetName(node.id);
    const position = this.getNodePosition(node.id);
    const nextWidget = node.nextNodeId
      ? this.resolveNextWidgetName(node.id, node.nextNodeId)
      : undefined;

    const properties: TwilioWidgetProperties = {
      offset: position,
      from: '{{flow.variables.address}}',
      to: '{{contact.channel.address}}',
      service: '{{trigger.message.InstanceSid}}',
      channel: '{{trigger.message.ChannelSid}}',
      timeout: String(node.timeout || DEFAULT_TIMEOUT),
      attributes: '{\n"is_bot": "Mensagem do bot"\n}',
    };

    // Se tem Content Template, usar content_template_sid
    if (node.contentTemplateSid) {
      properties.message_type = 'content_template';
      properties.content_sid = node.contentTemplateSid;
      properties.content_template_sid = node.contentTemplateSid;
      properties.body = node.content;
    } else {
      properties.message_type = 'custom';
      properties.body = node.content;
    }

    this.widgets.push({
      name: widgetName,
      type: 'send-and-wait-for-reply',
      properties,
      transitions: [{ event: 'incomingMessage', next: nextWidget }, { event: 'deliveryFailure' }],
    });
  }

  private createButtonsWidget(node: FlowNode): void {
    if (!node.buttons || node.buttons.length === 0) {
      this.createMessageWidget(node);
      return;
    }

    const messageWidgetName = this.getWidgetName(node.id);
    const splitWidgetName = `${messageWidgetName}_split`;
    const setResponseWidgetName = `${messageWidgetName}_set_response`;
    const position = this.getNodePosition(node.id);

    // Verificar se usa Content Template (botões interativos)
    const usesContentTemplate = Boolean(node.contentTemplateSid);

    const properties: TwilioWidgetProperties = {
      offset: position,
      from: '{{flow.variables.address}}',
      to: '{{contact.channel.address}}',
      service: '{{trigger.message.InstanceSid}}',
      channel: '{{trigger.message.ChannelSid}}',
      timeout: String(node.timeout || DEFAULT_TIMEOUT),
      attributes: '{\n"is_bot": "Mensagem do bot"\n}',
    };

    if (usesContentTemplate) {
      // Usar Content Template para botões interativos
      properties.message_type = 'content_template';
      properties.content_sid = node.contentTemplateSid;
      properties.content_template_sid = node.contentTemplateSid;
      properties.body = node.content;
    } else {
      // Fallback: mensagem com opções numeradas
      properties.message_type = 'custom';
      const buttonText = this.formatButtonsAsText(node.buttons);
      properties.body = `${node.content}\n\n${buttonText}`;
    }

    // Widget de mensagem com espera de resposta
    this.widgets.push({
      name: messageWidgetName,
      type: 'send-and-wait-for-reply',
      properties,
      transitions: [
        {
          event: 'incomingMessage',
          next: usesContentTemplate ? setResponseWidgetName : splitWidgetName,
        },
        { event: 'deliveryFailure' },
      ],
    });

    // Widget de split para avaliar resposta
    const splitTransitions = this.createButtonSplitTransitions(
      node.id,
      node.buttons,
      usesContentTemplate,
    );

    const splitY = this.getButtonsSplitY(node, position);

    if (usesContentTemplate) {
      const setResponseY = Math.round((position.y + splitY) / 2);
      this.widgets.push({
        name: setResponseWidgetName,
        type: 'set-variables',
        properties: {
          offset: {
            x: position.x,
            y: setResponseY,
          },
          variables: [
            {
              type: 'json_object',
              value: `{{widgets.${messageWidgetName}.inbound.Attributes}}`,
              key: 'response_id',
            },
          ],
        },
        transitions: [{ event: 'next', next: splitWidgetName }],
      });
    }

    this.widgets.push({
      name: splitWidgetName,
      type: 'split-based-on',
      properties: {
        offset: {
          x: position.x + LAYOUT.SPLIT_X_OFFSET,
          y: splitY,
        },
        // Se usa Content Template, ler ButtonPayload; senão, ler Body
        input: usesContentTemplate
          ? '{{flow.variables.response_id.content_response}}'
          : `{{widgets.${messageWidgetName}.inbound.Body}}`,
      },
      transitions: splitTransitions,
    });
  }

  private createTransferWidget(node: FlowNode): void {
    const widgetName = this.getWidgetName(node.id);
    const position = this.getNodePosition(node.id);
    const config = node.transferConfig || {};

    const attributes: Record<string, string> = {
      type: 'inbound',
      name: '{{trigger.message.ChannelAttributes.from}}',
      ...config.attributes,
    };

    const transitions: TwilioTransition[] = [
      { event: 'callComplete' },
      { event: 'failedToEnqueue' },
      { event: 'callFailure' },
    ];

    const baseProperties: TwilioWidgetProperties = {
      offset: position,
      workflow: config.workflowSid || 'WW00000000000000000000000000000000',
      channel: config.channelSid || 'TC00000000000000000000000000000000',
      attributes: JSON.stringify(attributes),
      priority: String(config.priority || 0),
      timeout: String(config.timeout || 86400),
      waitUrl: '',
      waitUrlMethod: 'POST',
    };

    this.widgets.push({
      name: widgetName,
      type: 'send-to-flex',
      properties: baseProperties,
      transitions,
    });

    const sources = this.transferIncomingSources.get(node.id) || [];
    const primarySource = this.transferPrimarySource.get(node.id);

    if (sources.length <= 1) return;

    for (const sourceId of sources) {
      if (!sourceId || sourceId === primarySource) continue;

      const cloneName = this.transferCloneByEdge.get(`${sourceId}=>${node.id}`);
      if (!cloneName) continue;

      const sourcePosition = this.getNodePosition(sourceId);

      this.widgets.push({
        name: cloneName,
        type: 'send-to-flex',
        properties: {
          ...baseProperties,
          offset: {
            x: sourcePosition.x,
            y: sourcePosition.y + LAYOUT.TRANSFER_CLONE_Y_OFFSET,
          },
        },
        transitions,
      });
    }
  }

  private formatButtonsAsText(buttons: FlowButton[]): string {
    return buttons.map((btn, index) => `${index + 1}. ${btn.label}`).join('\n');
  }

  private createButtonSplitTransitions(
    fromNodeId: string,
    buttons: FlowButton[],
    usesContentTemplate: boolean,
  ): TwilioTransition[] {
    const transitions: TwilioTransition[] = [];

    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      if (!button) continue;

      const nextWidget = this.resolveNextWidgetName(fromNodeId, button.nextNodeId);

      if (usesContentTemplate) {
        // Para Content Templates, usar equal_to com o id do botão (ButtonPayload retorna o id)
        transitions.push({
          event: 'match',
          conditions: [
            {
              type: 'equal_to',
              friendly_name: `If value equal_to ${button.id}`,
              value: button.id,
              arguments: ['{{flow.variables.response_id.content_response}}'],
            },
          ],
          next: nextWidget,
        });
      } else {
        // Para texto, aceitar número, valor ou label com matches_any_of
        const matchValues = [String(i + 1), button.value.toLowerCase(), button.label.toLowerCase()];
        const uniqueValues = [...new Set(matchValues.filter(Boolean))];

        transitions.push({
          event: 'match',
          conditions: [
            {
              type: 'matches_any_of',
              friendly_name: button.label,
              value: uniqueValues.join(','),
              arguments: uniqueValues,
            },
          ],
          next: nextWidget,
        });
      }
    }

    // Opção inválida volta para perguntar novamente
    transitions.push({ event: 'noMatch' });

    return transitions;
  }

  private getUniqueInternalWidgetName(baseName: string): string {
    const normalizedBase = this.getWidgetName(baseName);
    const used = new Set<string>(['Trigger']);

    for (const nodeId of this.nodeMap.keys()) {
      used.add(this.getWidgetName(nodeId));
    }

    let candidate = normalizedBase;
    let counter = 1;

    while (used.has(candidate)) {
      candidate = `${normalizedBase}_${counter}`;
      counter++;
    }

    return candidate;
  }

  private getWidgetName(nodeId: string): string {
    return nodeId.replace(/[^a-zA-Z0-9_]/g, '_');
  }
}

export const flowBuilder = new FlowBuilder();
