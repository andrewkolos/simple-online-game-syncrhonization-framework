import typescript from 'rollup-plugin-typescript2';
import resolve from 'rollup-plugin-node-resolve';

export default {
  input: 'demo/src/interpolation-reconciliation-demo.ts',
  output: {
    name: 'bundle',
    file: 'demo/build.js',
    format: 'iife',
    sourcemap: true
  },
  plugins: [
    resolve({
      extensions: ['.js', '.ts']
    }),
    typescript({
      tsconfig: 'tsconfig.demo.json',
      sourceMap: true,
    }),
  ]
}