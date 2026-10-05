// postject ships no type declarations; the surface we use is one function.
declare module 'postject' {
  export function inject(
    filename: string,
    resourceName: string,
    data: Buffer | string,
    options?: {
      sentinelFuse?: string;
      overwrite?: boolean;
    },
  ): Promise<void>;
}
