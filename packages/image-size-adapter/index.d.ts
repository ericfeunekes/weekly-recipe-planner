export type ImageDimensions = {
  width: number;
  height: number;
  type?: string;
};

export declare function imageSize(input: ArrayBuffer | Uint8Array): ImageDimensions;
export default imageSize;
