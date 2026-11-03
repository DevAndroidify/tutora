import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trim } from '../common/dto';

/** UPI VPA shape: handle@psp. Validated loosely; the PSP confirms it at payout time. */
export const UPI_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

export class UpsertTutorProfileDto {
  @ApiPropertyOptional({
    maxLength: 120,
    example: 'Ex-NSE analyst teaching charting for beginners',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  headline?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  experienceYears?: number;

  @ApiPropertyOptional({ type: [String], example: ['English', 'Hindi'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  languages?: string[];

  @ApiPropertyOptional({ example: 'tutor.name@okaxis', description: 'Private. Used for payouts.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(UPI_ID_PATTERN, { message: 'payoutUpiId must look like name@bank' })
  payoutUpiId?: string;
}

export class UpsertTutorSkillDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  experienceYears?: number;

  @ApiProperty({ minLength: 20, maxLength: 1000, description: 'What you teach and how.' })
  @Transform(trim)
  @IsString()
  @Length(20, 1000)
  summary!: string;

  @ApiProperty({
    type: [String],
    description: 'Up to 5 https links: portfolio, certificates, channel, published work.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  @MaxLength(500, { each: true })
  evidenceLinks!: string[];
}

export class SuggestSkillDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ minLength: 2, maxLength: 80, example: 'Options Trading Basics' })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}
