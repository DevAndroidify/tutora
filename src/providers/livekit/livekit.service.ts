import { Global, Injectable, Module } from '@nestjs/common';
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  WebhookReceiver,
  type WebhookEvent,
} from 'livekit-server-sdk';
import { AppConfig } from '../../platform/config/app-config';

export interface JoinTokenInput {
  room: string;
  identity: string;
  name: string;
  canPublish: boolean;
  ttlSeconds: number;
}

/**
 * LiveKit server API: health, short-lived room tokens and signed webhooks.
 * Media itself flows between clients and LiveKit; the backend never handles it.
 */
@Injectable()
export class LiveKitService {
  private readonly rooms: RoomServiceClient;
  private readonly receiver: WebhookReceiver;

  constructor(private readonly config: AppConfig) {
    const { url, apiKey, apiSecret } = config.livekit;
    this.rooms = new RoomServiceClient(url, apiKey, apiSecret, {
      requestTimeout: 3,
      failover: false,
    });
    this.receiver = new WebhookReceiver(apiKey, apiSecret);
  }

  /** Calls an authenticated API, so it checks both reachability and credentials. */
  async ping(): Promise<void> {
    await this.rooms.listRooms();
  }

  /** A token that can only join one room, as one fixed identity, for a short time. */
  async joinToken(input: JoinTokenInput): Promise<string> {
    const { apiKey, apiSecret } = this.config.livekit;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: input.identity,
      name: input.name,
      ttl: input.ttlSeconds,
    });
    at.addGrant({
      room: input.room,
      roomJoin: true,
      canPublish: input.canPublish,
      canSubscribe: true,
      canPublishData: true,
    });
    return at.toJwt();
  }

  /** Verifies the Authorization JWT (and body hash) LiveKit signs every webhook with. */
  receiveWebhook(rawBody: string, authHeader: string | undefined): Promise<WebhookEvent> {
    return this.receiver.receive(rawBody, authHeader);
  }
}

/** Starts and stops server-side recordings. Swappable so tests don't need a running Egress. */
export abstract class RecordingProvider {
  abstract start(room: string, objectKey: string): Promise<{ egressId: string }>;
  abstract stop(egressId: string): Promise<void>;
}

/** LiveKit Egress: records the room composite to MP4 and uploads it straight to S3/MinIO. */
@Injectable()
export class LiveKitEgressRecordingProvider extends RecordingProvider {
  private readonly egress: EgressClient;

  constructor(private readonly config: AppConfig) {
    super();
    const { url, apiKey, apiSecret } = config.livekit;
    this.egress = new EgressClient(url, apiKey, apiSecret);
  }

  async start(room: string, objectKey: string): Promise<{ egressId: string }> {
    const s = this.config.storage;
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: objectKey,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: s.accessKeyId,
          secret: s.secretAccessKey,
          region: s.region,
          // Egress runs inside Docker, so it reaches MinIO by its service name.
          endpoint: this.config.env.RECORDING_S3_ENDPOINT,
          bucket: s.bucket,
          forcePathStyle: true,
        }),
      },
    });
    const info = await this.egress.startRoomCompositeEgress(room, output, { layout: 'speaker' });
    return { egressId: info.egressId };
  }

  async stop(egressId: string): Promise<void> {
    await this.egress.stopEgress(egressId);
  }
}

@Global()
@Module({
  providers: [
    LiveKitService,
    { provide: RecordingProvider, useClass: LiveKitEgressRecordingProvider },
  ],
  exports: [LiveKitService, RecordingProvider],
})
export class LiveKitModule {}
