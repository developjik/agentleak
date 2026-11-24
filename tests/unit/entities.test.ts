import { expect, test } from 'vitest';
import { decodeEntities, extractRawText } from '../../src/html/text.js';
test('invalid Unicode numeric references use HTML replacement character without throwing',()=>{
 for(const input of ['&#x110000;', '&#X110000;', '&#999999999;', '&#0;', '&#xD800;', '&#xDFFF;', '&#'+'9'.repeat(400)+';']) expect(decodeEntities(input)).toBe('\uFFFD');
});
test('valid numeric references and adjacent body text survive',()=>{
 expect(decodeEntities('&#65; &#x41; &#X1F642; &#x10FFFF; &amp;')).toBe('A A 🙂 '+String.fromCodePoint(0x10ffff)+' &');
 expect(extractRawText('<body><p>Normal readable page content before &#x110000; and after for everyone.</p></body>')[0]!.text).toBe('Normal readable page content before � and after for everyone.');
});
test('decimal references only parse decimal digits and HTML C1 references match browser text',()=>{
 expect(decodeEntities('&#12ab;')).toBe('&#12ab;');expect(decodeEntities('&#128; &#x80;')).toBe('€ €');
});
