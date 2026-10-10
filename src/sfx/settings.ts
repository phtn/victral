import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { validationDecoder } from '../core/schema.js';

const volumeMessage = 'Volume must be between 0 and 1.';
export const AudioVolumeSchema = Schema.Number.check(
  Schema.isFinite({ message: volumeMessage }),
  Schema.isBetween({ minimum: 0, maximum: 1 }, { message: volumeMessage }),
).annotate({ identifier: volumeMessage });

export const AudioSettingsSchema = Schema.Struct({
  volume: AudioVolumeSchema.pipe(Schema.withDecodingDefault(Effect.succeed(0.5))),
  muted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type AudioSettings = typeof AudioSettingsSchema.Type;

export const parseAudioSettings = validationDecoder(AudioSettingsSchema, 'Audio settings', 'error');
export const parseAudioVolume = validationDecoder(AudioVolumeSchema, 'Audio volume');
export const parseVolumeAdjustment = validationDecoder(Schema.Finite.annotate({
  identifier: 'Volume adjustment must be a finite number.',
}), 'Audio volume adjustment');
