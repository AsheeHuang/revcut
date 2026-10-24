import { FPS, HEIGHT, WIDTH } from '@revcut/shared';
import { Composition, registerRoot } from 'remotion';
import { COMPOSITION_ID, type CompositionProps, recapDurationInFrames } from './props';
import { RecapVideo } from './RecapVideo';

// The server's Remotion bundle starts here; it always passes inputProps, so the defaults are never rendered.
const placeholder = { timeline: null, music: { src: '', beats: [] }, sources: {} } as unknown as CompositionProps;

registerRoot(() => (
  <Composition
    id={COMPOSITION_ID}
    component={RecapVideo}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    durationInFrames={1}
    defaultProps={placeholder}
    calculateMetadata={({ props }) => ({ durationInFrames: recapDurationInFrames(props) })}
  />
));
