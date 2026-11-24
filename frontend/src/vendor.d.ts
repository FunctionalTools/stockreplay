declare module 'plotly.js-basic-dist-min' {
  const Plotly: {
    newPlot: (
      node: HTMLElement,
      data: unknown[],
      layout: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown>
    purge: (node: HTMLElement) => void
    downloadImage: (node: HTMLElement, options: Record<string, unknown>) => Promise<unknown>
    Plots: { resize: (node: HTMLElement) => void }
  }
  export default Plotly
}
