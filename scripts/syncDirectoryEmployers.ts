import '../env';
import { syncDirectoryEmployers } from '../jobs-portal/directoryEmployersSync';

syncDirectoryEmployers()
    .then((result) => {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
