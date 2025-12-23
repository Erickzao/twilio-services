import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, HostListener, ViewChild } from '@angular/core';
import { AvatarModule } from 'primeng/avatar';
import { ButtonModule } from 'primeng/button';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';

type NodeType = 'start' | 'message' | 'question' | 'transfer';

type FlowNode = {
  id: string;
  type: NodeType;
  title: string;
  body: string;
  meta: string;
  x: number;
  y: number;
};

type FlowEdge = {
  id: string;
  from: string;
  to: string;
};

type DragState =
  | {
      kind: 'node';
      nodeId: string;
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | {
      kind: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | null;

@Component({
  selector: 'app-flow-builder',
  imports: [
    CommonModule,
    AvatarModule,
    ButtonModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    TagModule,
    TextareaModule,
  ],
  templateUrl: './flow-builder.html',
  styleUrl: './flow-builder.scss',
})
export class FlowBuilderComponent implements AfterViewInit {
  readonly canvasSize = { width: 2400, height: 1600 };
  readonly nodeSize = { width: 240, height: 120 };
  readonly minScale = 0.6;
  readonly maxScale = 1.4;
  private readonly viewportPadding = 0;

  readonly nodeLibrary: Array<{ type: NodeType; label: string; detail: string }> = [
    { type: 'message', label: 'Message', detail: 'Send a simple message card.' },
    { type: 'question', label: 'Question', detail: 'Wait for a reply or choice.' },
    { type: 'transfer', label: 'Transfer', detail: 'Route to a human agent.' },
  ];

  readonly nodeTypeMeta: Record<NodeType, { short: string; label: string }> = {
    start: { short: 'ST', label: 'Start' },
    message: { short: 'MSG', label: 'Message' },
    question: { short: 'Q', label: 'Question' },
    transfer: { short: 'TX', label: 'Transfer' },
  };

  readonly nodeTypeIcons: Record<NodeType, string> = {
    start: 'pi pi-bolt',
    message: 'pi pi-comment',
    question: 'pi pi-question-circle',
    transfer: 'pi pi-user',
  };

  nodes: FlowNode[] = [
    {
      id: 'node-1',
      type: 'start',
      title: 'Trigger',
      body: 'Inbound message arrives.',
      meta: 'Entry point',
      x: 120,
      y: 220,
    },
    {
      id: 'node-2',
      type: 'message',
      title: 'Greeting',
      body: 'Hi there! How can I help today?',
      meta: 'Auto message',
      x: 420,
      y: 200,
    },
    {
      id: 'node-3',
      type: 'question',
      title: 'Intent check',
      body: 'Pick a topic so I can route you.',
      meta: 'Waiting 30s',
      x: 760,
      y: 240,
    },
    {
      id: 'node-4',
      type: 'transfer',
      title: 'Handoff',
      body: 'Send to the best available agent.',
      meta: 'Queue: Support',
      x: 1120,
      y: 460,
    },
  ];

  edges: FlowEdge[] = [
    { id: 'edge-1', from: 'node-1', to: 'node-2' },
    { id: 'edge-2', from: 'node-2', to: 'node-3' },
    { id: 'edge-3', from: 'node-3', to: 'node-4' },
  ];

  selectedNodeId: string | null = 'node-2';

  panX = 220;
  panY = 120;
  scale = 1;

  @ViewChild('viewport', { static: true })
  private viewportRef!: ElementRef<HTMLDivElement>;

  private viewportSize = { width: 0, height: 0 };

  private dragState: DragState = null;
  private nextNodeId = 4;
  private nextEdgeId = 3;

  get selectedNode(): FlowNode | null {
    if (!this.selectedNodeId) return null;
    return this.nodes.find((node) => node.id === this.selectedNodeId) ?? null;
  }

  get zoomLabel(): string {
    return `${Math.round(this.scale * 100)}%`;
  }

  get canvasTransform(): string {
    return `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
  }

  trackById = (_: number, item: { id: string }) => item.id;

  selectNode(nodeId: string): void {
    this.selectedNodeId = nodeId;
  }

  ngAfterViewInit(): void {
    this.updateViewportSize();
    this.clampPan();
  }

  onNodePointerDown(event: PointerEvent, node: FlowNode): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    this.selectNode(node.id);

    this.dragState = {
      kind: 'node',
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.x,
      originY: node.y,
    };
    this.setDragging(true);
  }

  onCanvasPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dragState = {
      kind: 'pan',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: this.panX,
      originY: this.panY,
    };
    this.setDragging(true);
  }

  @HostListener('window:pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    const drag = this.dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;

    if (drag.kind === 'pan') {
      this.panX = drag.originX + (event.clientX - drag.startX);
      this.panY = drag.originY + (event.clientY - drag.startY);
      this.clampPan();
      return;
    }

    const node = this.nodes.find((item) => item.id === drag.nodeId);
    if (!node) return;

    const deltaX = (event.clientX - drag.startX) / this.scale;
    const deltaY = (event.clientY - drag.startY) / this.scale;
    node.x = drag.originX + deltaX;
    node.y = drag.originY + deltaY;
  }

  @HostListener('window:pointerup', ['$event'])
  onPointerUp(event: PointerEvent): void {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    this.dragState = null;
    this.setDragging(false);
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const next = this.scale + -event.deltaY / 900;
    this.scale = this.clamp(next, this.minScale, this.maxScale);
    this.clampPan();
  }

  zoomIn(): void {
    this.scale = this.clamp(this.scale + 0.1, this.minScale, this.maxScale);
    this.clampPan();
  }

  zoomOut(): void {
    this.scale = this.clamp(this.scale - 0.1, this.minScale, this.maxScale);
    this.clampPan();
  }

  zoomReset(): void {
    this.scale = 1;
    this.panX = 220;
    this.panY = 120;
    this.clampPan();
  }

  addNode(type: NodeType): void {
    const baseX = this.selectedNode ? this.selectedNode.x + 280 : 180;
    const baseY = this.selectedNode ? this.selectedNode.y + 140 : 220;

    this.nextNodeId += 1;
    const nodeId = `node-${this.nextNodeId}`;

    const newNode: FlowNode = {
      id: nodeId,
      type,
      title: `${this.nodeTypeMeta[type].label} node`,
      body: 'Edit the message content here.',
      meta: 'Draft',
      x: baseX,
      y: baseY,
    };

    this.nodes = [...this.nodes, newNode];

    if (this.selectedNodeId) {
      this.nextEdgeId += 1;
      this.edges = [...this.edges, { id: `edge-${this.nextEdgeId}`, from: this.selectedNodeId, to: nodeId }];
    }

    this.selectNode(nodeId);
  }

  updateSelected(field: 'title' | 'body' | 'meta', event: Event): void {
    if (!this.selectedNodeId) return;
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const value = target.value;

    this.nodes = this.nodes.map((node) => {
      if (node.id !== this.selectedNodeId) return node;
      return { ...node, [field]: value };
    });
  }

  getEdgePath(edge: FlowEdge): string {
    const from = this.nodes.find((node) => node.id === edge.from);
    const to = this.nodes.find((node) => node.id === edge.to);
    if (!from || !to) return '';

    const startX = from.x + this.nodeSize.width;
    const startY = from.y + this.nodeSize.height / 2;
    const endX = to.x;
    const endY = to.y + this.nodeSize.height / 2;
    const bend = Math.max(80, Math.min(220, (endX - startX) * 0.5));

    return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.updateViewportSize();
    this.clampPan();
  }

  private updateViewportSize(): void {
    const rect = this.viewportRef.nativeElement.getBoundingClientRect();
    this.viewportSize = { width: rect.width, height: rect.height };
  }

  private clampPan(): void {
    const { width, height } = this.viewportSize;
    if (!width || !height) return;

    const scaledWidth = this.canvasSize.width * this.scale;
    const scaledHeight = this.canvasSize.height * this.scale;
    const padding = this.viewportPadding;

    if (scaledWidth <= width) {
      this.panX = (width - scaledWidth) / 2;
    } else {
      const minX = width - scaledWidth - padding;
      const maxX = padding;
      this.panX = this.clamp(this.panX, minX, maxX);
    }

    if (scaledHeight <= height) {
      this.panY = (height - scaledHeight) / 2;
    } else {
      const minY = height - scaledHeight - padding;
      const maxY = padding;
      this.panY = this.clamp(this.panY, minY, maxY);
    }
  }

  private setDragging(active: boolean): void {
    document.body.classList.toggle('is-dragging', active);
  }
}
