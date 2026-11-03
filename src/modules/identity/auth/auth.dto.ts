import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterDto {
  @ApiProperty({ example: 'asha@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 10, maxLength: 128, example: 'correct-horse-battery' })
  @IsString()
  @Length(10, 128)
  password!: string;

  @ApiProperty({ example: 'Asha Verma' })
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  fullName!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'asha@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}
