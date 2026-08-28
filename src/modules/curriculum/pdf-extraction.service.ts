import { Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';

export interface ExtractedPage {
  page: number;
  text: string;
}

@Injectable()
export class PdfExtractionService {
  /**
   * NERDC curriculum PDFs lay out roughly one topic table per page, so
   * per-page text is the natural unit to hand to the LLM extraction step -
   * small enough for a local model's context window, and it keeps the
   * `page` provenance on each extracted topic for the review UI.
   */
  async extractPages(buffer: Buffer): Promise<ExtractedPage[]> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.pages.map((p) => ({ page: p.num, text: p.text }));
    } finally {
      await parser.destroy();
    }
  }
}
