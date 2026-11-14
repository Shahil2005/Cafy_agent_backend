import dotenv from 'dotenv';


const result = dotenv.config();

if (result.error) {
    console.error('Error loading .env file:', result.error);
} else if (process.env.NODE_ENV !== 'production') {
    console.log('.env file loaded successfully');
}

