import { Body, Cached, Controller, Delete, Get, HttpError, HttpResponse, PathParam, Post, QueryParam, revalidatePath } from 'amoxi';
import type { NewUser, User } from '../domain/user';
import { UserLimitReachedError, UserService } from '../service/user-service';

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  // Cached for 30 s (stale-while-revalidate 60 s); invalidated on every change below.
  @Get()
  @Cached(30, { staleWhileRevalidate: 60 })
  list(@QueryParam() limit?: number): User[] {
    return this.users.list(limit);
  }

  @Get('/:id')
  get(@PathParam() id: number): User | HttpResponse {
    return this.users.get(id) ?? HttpResponse.notFound(`No person with id ${id}`);
  }

  // `body` is validated against NewUser at runtime by generated code: wrong types, missing
  // fields, bad emails and unknown properties never reach this method.
  @Post()
  create(@Body() body: NewUser): HttpResponse<User> {
    try {
      const user = this.users.register({ name: body.name.trim(), email: body.email.trim() });
      revalidatePath('/users');
      return HttpResponse.created(user, `/users/${user.id}`);
    } catch (err) {
      if (err instanceof UserLimitReachedError) throw new HttpError(409, err.message);
      throw err;
    }
  }

  @Delete('/:id')
  remove(@PathParam() id: number): HttpResponse {
    if (!this.users.remove(id)) return HttpResponse.notFound(`No person with id ${id}`);
    revalidatePath('/users');
    return HttpResponse.noContent();
  }
}
