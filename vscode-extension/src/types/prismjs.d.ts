declare module 'prismjs' {
  interface Grammar {}

  interface PrismStatic {
    languages: Record<string, Grammar | undefined>;
    highlight(code: string, grammar: Grammar, language: string): string;
  }

  const Prism: PrismStatic;
  export default Prism;
}

declare module 'prismjs/components/*';
