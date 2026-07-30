import { d as PGliteInterface } from '../pglite-CpaPhfpC.cjs';

declare const amcheck: {
    name: string;
    setup: (_pg: PGliteInterface, _emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { amcheck };
