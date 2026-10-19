import { Controller, Get, HttpError, HttpResponse, Multipart, PathParam, Post, type MultipartForm } from 'amoxi';
import { ActivityHub } from '../activity/activity-hub';
import { UserService } from '../service/user-service';
import { AvatarStore } from './avatar-store';

@Controller('/users/:id/avatar')
export class AvatarController {
  constructor(
    private readonly users: UserService,
    private readonly avatars: AvatarStore,
    private readonly activity: ActivityHub,
  ) {}

  /** Get a person's profile photo. */
  @Get()
  get(@PathParam() id: number): HttpResponse {
    const avatar = this.avatars.find(id);
    if (!avatar) return HttpResponse.notFound('No photo');
    return HttpResponse.file(avatar.path, { contentType: avatar.type, cacheControl: 'public, max-age=60' });
  }

  /**
   * Upload a profile photo.
   *
   * Send multipart/form-data with an `avatar` file field (PNG, JPEG, GIF or WebP, up to 2 MB).
   */
  @Post()
  async upload(@PathParam() id: number, @Multipart() form: MultipartForm): Promise<HttpResponse<{ url: string }>> {
    const user = this.users.get(id);
    if (!user) throw new HttpError(404, `No person with id ${id}`);
    const file = form.file('avatar');
    if (!file) throw new HttpError(400, "Add an image in the 'avatar' field");
    await this.avatars.save(id, file);
    this.activity.publish('photo', user.name);
    return HttpResponse.created({ url: `/users/${id}/avatar` });
  }
}
