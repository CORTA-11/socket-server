import { Redis } from "ioredis";

const deletionTTL = 5 * 60_000;
const deletionChannel = "corta:collaboration:document-deletions";
const deletionKeyPrefix = "corta:collaboration:deleted:";

export interface RoomLifecycle {
  delete(roomName: string): Promise<void>;
  destroy(): Promise<void>;
  health(): Promise<boolean>;
  isDeleted(roomName: string): Promise<boolean>;
  start(onDeleted: (roomName: string) => void): Promise<void>;
}

export class RedisRoomLifecycle implements RoomLifecycle {
  private readonly client: Redis;
  private readonly subscriber: Redis;
  private healthCheck: Promise<boolean> | undefined;

  constructor(redisURL: string, commandTimeout = 2_000) {
    const options = { commandTimeout, enableOfflineQueue: false, lazyConnect: true };
    this.client = new Redis(redisURL, options);
    this.subscriber = new Redis(redisURL, options);
  }

  async start(onDeleted: (roomName: string) => void): Promise<void> {
    this.subscriber.on("message", (_channel: string, roomName: string) => onDeleted(roomName));
    await Promise.all([this.client.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(deletionChannel);
  }

  async delete(roomName: string): Promise<void> {
    const result = await this.client.multi()
      .set(deletionKey(roomName), "1", "PX", deletionTTL)
      .publish(deletionChannel, roomName)
      .exec();
    if (result === null || result.some(([error]) => error !== null)) {
      throw new Error("Redis Document Room deletion transaction failed");
    }
  }

  async health(): Promise<boolean> {
    if (this.healthCheck === undefined) {
      this.healthCheck = this.checkHealth().finally(() => {
        this.healthCheck = undefined;
      });
    }
    return this.healthCheck;
  }

  async isDeleted(roomName: string): Promise<boolean> {
    return await this.client.exists(deletionKey(roomName)) === 1;
  }

  async destroy(): Promise<void> {
    await Promise.allSettled([this.subscriber.quit(), this.client.quit()]);
  }

  private async checkHealth(): Promise<boolean> {
    try {
      await Promise.all([this.client.ping(), this.subscriber.ping()]);
      return true;
    } catch {
      return false;
    }
  }
}

// Unit tests inject and share this implementation to model multiple replicas.
export class InMemoryRoomLifecycle implements RoomLifecycle {
  private readonly deletedRooms = new Set<string>();
  private readonly listeners = new Set<(roomName: string) => void>();
  private readonly timers = new Set<NodeJS.Timeout>();

  async start(onDeleted: (roomName: string) => void): Promise<void> {
    this.listeners.add(onDeleted);
  }

  async delete(roomName: string): Promise<void> {
    this.deletedRooms.add(roomName);
    const timer = setTimeout(() => {
      this.deletedRooms.delete(roomName);
      this.timers.delete(timer);
    }, deletionTTL);
    timer.unref();
    this.timers.add(timer);
    this.listeners.forEach((listener) => listener(roomName));
  }

  async health(): Promise<boolean> {
    return true;
  }

  async isDeleted(roomName: string): Promise<boolean> {
    return this.deletedRooms.has(roomName);
  }

  async destroy(): Promise<void> {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.listeners.clear();
  }
}

function deletionKey(roomName: string): string {
  return deletionKeyPrefix + roomName;
}
