import type { Hocuspocus } from "@hocuspocus/server";

import type { DocumentTicketClaims } from "./auth.js";

type Counter = "authenticationFailures" | "healthChecks" | "healthFailures" |
  "loadFailures" | "reconnects" | "slowEditingSessions" | "storeFailures";

export interface HealthDependency {
  health(): Promise<boolean>;
  name: string;
}

export class CollaborationObservability {
  private readonly counters: Record<Counter, number> = {
    authenticationFailures: 0,
    healthChecks: 0,
    healthFailures: 0,
    loadFailures: 0,
    reconnects: 0,
    slowEditingSessions: 0,
    storeFailures: 0,
  };
  private readonly activeIdentities = new Map<string, number>();
  private readonly recentDisconnects = new Map<string, number>();
  private healthy = 0;

  increment(counter: Counter): void {
    this.counters[counter] += 1;
  }

  healthResult(healthy: boolean): void {
    this.increment("healthChecks");
    this.healthy = healthy ? 1 : 0;
    if (!healthy) {
      this.increment("healthFailures");
    }
  }

  authenticated(claims: DocumentTicketClaims): void {
    const identity = editingIdentity(claims);
    const active = this.activeIdentities.get(identity) ?? 0;
    this.expireReconnects();
    if (active === 0 && this.recentDisconnects.delete(identity)) {
      this.increment("reconnects");
    }
    this.activeIdentities.set(identity, active + 1);
  }

  disconnected(claims: DocumentTicketClaims): void {
    const identity = editingIdentity(claims);
    const active = this.activeIdentities.get(identity) ?? 0;
    if (active <= 1) {
      this.activeIdentities.delete(identity);
      this.recentDisconnects.set(identity, Date.now());
      this.expireReconnects();
      return;
    }
    this.activeIdentities.set(identity, active - 1);
  }

  private expireReconnects(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [identity, disconnectedAt] of this.recentDisconnects) {
      if (disconnectedAt >= cutoff && this.recentDisconnects.size <= 10_000) {
        break;
      }
      this.recentDisconnects.delete(identity);
    }
  }

  render(instance: Hocuspocus): string {
    return [
      gauge("active_rooms", "Active Document Rooms", instance.getDocumentsCount()),
      gauge("active_editing_sessions", "Active Editing Sessions", instance.getConnectionsCount()),
      gauge("healthy", "Most recent collaboration dependency health result", this.healthy),
      counter("authentication_failures", "Rejected collaboration authentications", this.counters.authenticationFailures),
      counter("load_failures", "Failed Document state loads", this.counters.loadFailures),
      counter("store_failures", "Failed Document state stores", this.counters.storeFailures),
      counter("reconnects", "Successful Editing Session reconnections", this.counters.reconnects),
      counter("slow_editing_sessions", "Editing Sessions closed for excessive backpressure", this.counters.slowEditingSessions),
      counter("health_checks", "Collaboration health checks", this.counters.healthChecks),
      counter("health_failures", "Failed collaboration health checks", this.counters.healthFailures),
    ].join("");
  }
}

function editingIdentity(claims: DocumentTicketClaims): string {
  return `${claims.organizationId}:${claims.teamId}:${claims.documentId}:${claims.userId}`;
}

function gauge(name: string, help: string, value: number): string {
  return metric("gauge", name, help, value);
}

function counter(name: string, help: string, value: number): string {
  return metric("counter", `${name}_total`, help, value);
}

function metric(type: "counter" | "gauge", name: string, help: string, value: number): string {
  const fullName = `corta_collaboration_${name}`;
  return `# HELP ${fullName} ${help}\n# TYPE ${fullName} ${type}\n${fullName} ${value}\n`;
}
