import { Controller, Get, HttpError, HttpResponse, PathParam } from 'amoxi';
import { productSvg } from './art';
import { Catalog } from './catalog';

/** Product illustrations, generated from the catalog data: /art/OG-1101.svg or /art/OG-1101-EMBER.svg. */
@Controller('/art')
export class ArtController {
  constructor(private readonly catalog: Catalog) {}

  @Get('/:file')
  art(@PathParam() file: string) {
    const id = file.replace(/\.svg$/i, '');
    const found = this.catalog.variant(id);
    const product = found?.product ?? this.catalog.get(id);
    if (!product) throw new HttpError(404, 'No such illustration');
    return new HttpResponse(200, productSvg(product, found?.variant), { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
  }
}
