import 'jquery';

declare module 'jquery' {
  interface JQuery<TElement = HTMLElement> {
    ripples(...args: any[]): JQuery<TElement>;
  }
}

declare module 'jquery.ripples';
