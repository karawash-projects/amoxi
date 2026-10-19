import { Bean, Factory, Value } from 'amoxi';
import { type Clock, SystemClock } from './clock';
import { type IdGenerator, SequenceIdGenerator } from './id-generator';

/** Beans for third-party / plain classes that carry no decorators themselves. */
@Factory()
export class InfrastructureFactory {
  @Bean()
  clock(): Clock {
    return new SystemClock();
  }

  @Bean()
  idGenerator(@Value('${users.id-start:1}') start: number): IdGenerator {
    return new SequenceIdGenerator(start);
  }
}
