from library import load_books, save_books


books = load_books()


while True:
    print("\n==============================")
    print("      📚 МОЯ БИБЛИОТЕКА")
    print("==============================")
    print("1. Показать все книги")
    print("2. Добавить книгу")
    print("3. Удалить книгу")
    print("4. Найти книгу")
    print("5. Отметить книгу прочитанной")
    print("6. Показать статистику")
    print("0. Выйти")
    print("==============================")

    choice = input("Выберите действие: ")

    if choice == "1":
        if not books:
            print("Библиотека пока пустая.")
        else:
            print("\n===== МОИ КНИГИ =====")

            for book in books:
                print("Название:", book["title"])
                print("Автор:", book["author"])

                if book["read"]:
                    print("Статус: Прочитана")
                else:
                    print("Статус: Не прочитана")

                print("----------------------")

    elif choice == "2":
        title = input("Название книги: ").strip()

        if not title:
            print("❌ Название книги не может быть пустым!")
            continue

        author = input("Автор: ").strip()

        if not author:
            print("❌ Автор не может быть пустым!")
            continue

        book = {
            "title": title,
            "author": author,
            "read": False
        }

        books.append(book)
        save_books(books)
        print("Книга добавлена!")

    elif choice == "3":
        if not books:
            print("Библиотека пока пустая.")
        else:
            print("\n===== КНИГИ =====")

            for index, book in enumerate(books, start=1):
                print(f"{index}. {book['title']} — {book['author']}")

            number = input("Введите номер книги для удаления: ")

            if number.isdigit():
                number = int(number)

                if 1 <= number <= len(books):
                    deleted_book = books.pop(number - 1)
                    save_books(books)

                    print("Книга удалена!")
                    print("Удалена:", deleted_book["title"])
                else:
                    print("Такого номера книги нет.")
            else:
                print("Введите число.")

    elif choice == "4":
        search = input("Введите название книги для поиска: ")

        found_books = []

        for book in books:
            if search.lower() in book["title"].lower():
                found_books.append(book)

        if found_books:
            print("\n===== НАЙДЕННЫЕ КНИГИ =====")

            for book in found_books:
                print("Название:", book["title"])
                print("Автор:", book["author"])

                if book["read"]:
                    print("Статус: Прочитана")
                else:
                    print("Статус: Не прочитана")

                print("----------------------")
        else:
            print("Книги не найдены.")

    elif choice == "5":
        if not books:
            print("Библиотека пока пустая.")
        else:
            print("\n===== КНИГИ =====")

            for index, book in enumerate(books, start=1):
                if book["read"]:
                    status = "Прочитана"
                else:
                    status = "Не прочитана"

                print(f"{index}. {book['title']} — {book['author']} [{status}]")

            number = input("Введите номер прочитанной книги: ")

            if number.isdigit():
                number = int(number)

                if 1 <= number <= len(books):
                    books[number - 1]["read"] = True
                    save_books(books)
                    print("Книга отмечена как прочитанная!")
                else:
                    print("Такого номера книги нет.")
            else:
                print("Введите число.")

    elif choice == "6":
        total_books = len(books)
        read_books = sum(1 for book in books if book["read"])
        unread_books = total_books - read_books

        print("\n===== СТАТИСТИКА =====")
        print(f"Всего книг: {total_books}")
        print(f"Прочитано: {read_books}")
        print(f"Не прочитано: {unread_books}")
        print("======================")

    elif choice == "0":
        print("До свидания!")
        break

    else:
        print("Такого пункта нет.")