import { Controller, Get, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../platform/http/route-metadata';
import { CatalogModule } from '../../modules/catalog/catalog.module';
import {
  CatalogService,
  type CategoryTreeView,
  type Page,
  type SkillDetailView,
  type SkillView,
} from '../../modules/catalog/catalog.service';
import { TutorsModule } from '../../modules/tutors/tutors.module';
import { TutorsService, type PublicTutorView } from '../../modules/tutors/tutors.service';
import { MasteryModule, MasteryService } from '../../modules/mastery/mastery.service';
import { SkillSearchQuery, TutorSearchQuery } from '../common/dto';

@ApiTags('public: catalog')
@Public()
@Controller('public')
export class PublicCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @ApiOperation({ summary: 'Active categories with their sub-categories.' })
  categories(): Promise<CategoryTreeView[]> {
    return this.catalog.categoryTree();
  }

  @Get('skills')
  @ApiOperation({ summary: 'Search active skills by text and/or category.' })
  skills(@Query() q: SkillSearchQuery): Promise<Page<SkillView>> {
    return this.catalog.searchSkills(q);
  }

  @Get('skills/:idOrSlug')
  @ApiOperation({ summary: 'One skill with its category and topics. Accepts id or slug.' })
  skill(@Param('idOrSlug') idOrSlug: string): Promise<SkillDetailView> {
    return this.catalog.getSkill(idOrSlug);
  }
}

@ApiTags('public: tutors')
@Public()
@Controller('public/tutors')
export class PublicTutorsController {
  constructor(
    private readonly tutors: TutorsService,
    private readonly mastery: MasteryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Verified tutors, optionally only those approved for a skill.' })
  list(@Query() q: TutorSearchQuery): Promise<Page<PublicTutorView>> {
    return this.tutors.listPublicTutors(q);
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Public profile of a verified tutor (approved skills only).' })
  async get(@Param('userId', new ParseUUIDPipe()) userId: string) {
    const profile: PublicTutorView = await this.tutors.getPublicProfile(userId);
    const rating = (await this.mastery.ratings([userId])).get(userId) ?? {
      average: null,
      count: 0,
    };
    const skills = await Promise.all(
      profile.skills.map(async (s) => ({
        ...s,
        mastery: (await this.mastery.scores([userId], s.skill.id)).get(userId)!,
      })),
    );
    return { ...profile, skills, rating };
  }
}

/** Unauthenticated browsing shared by the student and tutor apps (/public/*). */
@Module({
  imports: [CatalogModule, TutorsModule, MasteryModule],
  controllers: [PublicCatalogController, PublicTutorsController],
})
export class PublicAppModule {}
